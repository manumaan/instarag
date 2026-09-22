import { randomUUID } from 'node:crypto';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { ddb } from '../shared/ddb';
import { badRequest, handler, parseJsonBody } from '../shared/http';
import { retrieve, type Hit } from './retrieve';

const THREADS_TABLE = process.env.THREADS_TABLE!;
const MESSAGES_TABLE = process.env.MESSAGES_TABLE!;
const MODEL_ID = process.env.ANALYSIS_MODEL_ID!;

const bedrock = new AnthropicBedrock({ awsRegion: process.env.AWS_REGION });

const CitationSchema = z.object({
  media_id: z.string(),
  ts_ms: z.number(),
});

const AnswerSchema = z.object({
  answered: z
    .boolean()
    .describe('false when the provided frames do not contain enough to answer'),
  answer: z.string().describe('the answer, or a plain statement of what is missing when answered is false'),
  citations: z
    .array(CitationSchema)
    .describe('the frames the answer rests on; empty only when answered is false'),
});

interface AskBody {
  question?: string;
  mediaId?: string;
  threadId?: string;
}

/** POST /ask — RAG over the frame index, answering only from retrieved frames. */
export const main = handler(async (event) => {
  const body = parseJsonBody<AskBody>(event);
  const question = body.question?.trim();
  if (!question) throw badRequest('question is required');
  if (question.length > 1000) throw badRequest('question is too long');

  const hits = await retrieve(question, { mediaId: body.mediaId });

  if (hits.length === 0) {
    return {
      threadId: body.threadId ?? null,
      answered: false,
      answer:
        body.mediaId
          ? 'Nothing has been indexed for this reel yet, so there is nothing to answer from.'
          : 'Your library has nothing indexed yet, so there is nothing to answer from.',
      citations: [],
    };
  }

  const response = await bedrock.messages.parse({
    model: MODEL_ID,
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low', format: zodOutputFormat(AnswerSchema) },
    system: [
      'You answer questions about Instagram reels using only the moments provided.',
      'Each moment carries its media_id and ts_ms. A frame moment says what is visible and any',
      'text read off it verbatim; a speech moment is what was said aloud at that point.',
      '',
      'Rules:',
      '- Answer only from the frames given. Never use outside knowledge about a place or brand.',
      '- Cite the frames your answer rests on, by media_id and ts_ms.',
      '- A name is only established if it appears in a frame\'s text or was spoken. If you are',
      '  reasoning from appearance rather than text or speech, say so in the answer.',
      '- If the frames do not support an answer, set answered to false and say what is missing.',
      '  That is a correct outcome, not a failure.',
    ].join('\n'),
    messages: [{ role: 'user', content: `${formatContext(hits)}\n\nQuestion: ${question}` }],
  });

  const parsed = response.parsed_output;
  if (!parsed) throw new Error(`model returned no parsable answer (stop_reason ${response.stop_reason})`);

  // A citation must point at a moment we actually retrieved, or it is not a
  // citation. Keyed on media_id + ts_ms only: hitKey also carries the kind,
  // which a citation does not name, and matching on it silently dropped every
  // citation the model produced.
  const retrieved = new Set(hits.map((hit) => `${hit.mediaId}:${hit.tsMs}`));
  const citations = parsed.citations.filter((c) => retrieved.has(`${c.media_id}:${c.ts_ms}`));

  const threadId = body.threadId ?? randomUUID();
  await persist(threadId, body.mediaId, question, parsed.answer, citations);

  return {
    threadId,
    answered: parsed.answered && citations.length > 0,
    answer: parsed.answer,
    citations,
    retrieved: hits.map((hit) => ({ media_id: hit.mediaId, ts_ms: hit.tsMs })),
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
});

function formatContext(hits: Hit[]): string {
  return hits
    .map((hit) =>
      [
        `--- ${hit.kind} media_id=${hit.mediaId} ts_ms=${hit.tsMs}`,
        hit.speech && `said aloud: ${hit.speech}`,
        hit.description && `visible: ${hit.description}`,
        hit.ocrText && `text in frame (verbatim): ${hit.ocrText}`,
        hit.places && `places named in this reel: ${hit.places}`,
        hit.caption && `reel caption: ${hit.caption}`,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
}

async function persist(
  threadId: string,
  mediaId: string | undefined,
  question: string,
  answer: string,
  citations: Array<{ media_id: string; ts_ms: number }>,
) {
  const now = new Date().toISOString();
  const existing = await ddb.send(
    new QueryCommand({
      TableName: MESSAGES_TABLE,
      KeyConditionExpression: 'thread_id = :t',
      ExpressionAttributeValues: { ':t': threadId },
      Limit: 1,
    }),
  );
  if ((existing.Count ?? 0) === 0) {
    await ddb.send(
      new PutCommand({
        TableName: THREADS_TABLE,
        Item: {
          id: threadId,
          entity: 'thread',
          scope: mediaId ? 'media' : 'library',
          media_id: mediaId,
          title: question.slice(0, 120),
          created_at: now,
        },
      }),
    );
  }
  await ddb.send(
    new PutCommand({
      TableName: MESSAGES_TABLE,
      Item: { thread_id: threadId, created_at: now, role: 'user', content: question },
    }),
  );
  await ddb.send(
    new PutCommand({
      TableName: MESSAGES_TABLE,
      // Microsecond suffix keeps the answer after its question in sort order.
      Item: {
        thread_id: threadId,
        created_at: `${now}#a`,
        role: 'assistant',
        content: answer,
        citations,
      },
    }),
  );
}

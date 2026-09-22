/** The instruction that accompanies a reel's keyframes. */
export function buildInstruction(options: { caption?: string; permalink?: string }): string {
  const lines = [
    'These are the keyframes of one Instagram reel, in order. Each is labelled with its ts_ms.',
    '',
    'Return exactly one frames entry per labelled ts_ms, reusing those values verbatim. Do not invent',
    'timestamps and do not merge frames.',
    '',
    'ocr_text must be verbatim and must include shop signage, awning and window text, menu boards,',
    'street signs and on-screen captions. On-screen captions often continue across consecutive frames:',
    'read them in sequence so the reel makes sense as a whole.',
    '',
    'places is what makes questions like "which cafe is in this reel" answerable. Set basis to',
    'read_from_frame only when the name is actually legible in a frame, and attach the evidence you',
    'read it from with the ts_ms it came from. Use from_caption when only the caption names it, and',
    'inferred when you are reasoning from architecture, language or style. Never present an inferred',
    'place as though you read it. Prefer leaving places empty over guessing a name.',
  ];

  if (options.caption) {
    lines.push('', 'Caption posted with the reel:', options.caption);
    lines.push('', 'Leave caption_from_frames empty: the caption is already known.');
  } else {
    lines.push(
      '',
      'This reel has no caption stored. If the post caption is legible in any frame, return it verbatim',
      'in caption_from_frames; otherwise leave that empty.',
    );
  }
  if (options.permalink) lines.push('', `Source: ${options.permalink}`);

  return lines.join('\n');
}

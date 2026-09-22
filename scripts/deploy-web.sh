#!/usr/bin/env bash
# Builds the web app and deploys everything, including the static site.
#
# Order matters: a static export inlines NEXT_PUBLIC_* at build time, so the
# env file has to be written from the stack outputs before `next build`, and
# the built `web/out` has to exist before `cdk deploy` uploads it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export AWS_REGION="${AWS_REGION:-us-east-1}"
export CDK_DEFAULT_REGION="$AWS_REGION"

echo "==> writing web/.env.local from the deployed stack"
"$ROOT/scripts/write-web-env.sh" >/dev/null

echo "==> building the static site"
npm --prefix "$ROOT/web" run build >/dev/null

echo "==> deploying (uploads web/out and invalidates the CloudFront cache)"
npm --prefix "$ROOT/infra" run deploy -- --require-approval never "$@"

SITE=$(aws cloudformation describe-stacks --stack-name "${STACK:-ReelLens}" \
  --query "Stacks[0].Outputs[?OutputKey=='HostingSiteUrl'].OutputValue" --output text 2>/dev/null \
  || aws cloudformation describe-stacks --stack-name "${STACK:-ReelLens}" \
     --query "Stacks[0].Outputs[?contains(OutputKey,'SiteUrl')].OutputValue" --output text)
echo
echo "live at: $SITE"

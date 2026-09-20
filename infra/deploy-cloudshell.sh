#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-2}}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

echo "AWS account: ${ACCOUNT_ID}"
echo "AWS region:  ${REGION}"
echo

if [[ "${REGION}" != "us-east-2" ]]; then
  echo "Refusing to deploy outside us-east-2."
  echo "Set AWS_DEFAULT_REGION=us-east-2 and try again."
  exit 1
fi

cd "$(dirname "$0")"

echo "Installing infrastructure dependencies locally in CloudShell..."
npm install

echo "Building CDK app..."
npm run build

echo "Synthesizing CloudFormation template (no AWS resources are created)..."
CDK_DEFAULT_ACCOUNT="${ACCOUNT_ID}" CDK_DEFAULT_REGION="${REGION}"   npx cdk synth >/dev/null

echo
echo "Previewing deployment diff (no AWS resources are created)..."
CDK_DEFAULT_ACCOUNT="${ACCOUNT_ID}" CDK_DEFAULT_REGION="${REGION}"   npx cdk diff || true

echo
echo "READY FOR AWS DEPLOYMENT"
echo "The next step may bootstrap CDK if needed, then create Cognito, API Gateway,"
echo "Lambda, Aurora Serverless v2, S3, networking, logs, and related IAM resources."
read -r -p "Type DEPLOY to create/update AWS resources, or anything else to cancel: " CONFIRM
if [[ "${CONFIRM}" != "DEPLOY" ]]; then
  echo "Deployment cancelled. No deployment resources were intentionally created."
  exit 0
fi

echo "Bootstrapping CDK (safe to rerun)..."
CDK_DEFAULT_ACCOUNT="${ACCOUNT_ID}" CDK_DEFAULT_REGION="${REGION}"   npx cdk bootstrap "aws://${ACCOUNT_ID}/${REGION}"

CDK_DEFAULT_ACCOUNT="${ACCOUNT_ID}" CDK_DEFAULT_REGION="${REGION}"   npx cdk deploy GingerDragonProd   --require-approval never   --outputs-file cdk-outputs.json

echo
echo "Deployment complete. CloudFormation outputs:"
cat cdk-outputs.json

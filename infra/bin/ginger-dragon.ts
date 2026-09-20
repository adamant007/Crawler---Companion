#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { GingerDragonStack } from "../lib/ginger-dragon-stack";

const app = new cdk.App();

new GingerDragonStack(app, "GingerDragonProd", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-2",
  },
  description: "Ginger Dragon RPG Companion production foundation",
});

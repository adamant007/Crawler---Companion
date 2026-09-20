import fs from "node:fs";
import path from "node:path";
import {
  BeginTransactionCommand,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  RDSDataClient,
  RollbackTransactionCommand,
} from "@aws-sdk/client-rds-data";

const rds = new RDSDataClient({});
const resourceArn = process.env.DB_CLUSTER_ARN;
const secretArn = process.env.DB_SECRET_ARN;
const database = process.env.DB_NAME || "gingerdragon";

async function exec(sql, parameters = [], transactionId) {
  return rds.send(new ExecuteStatementCommand({
    resourceArn,
    secretArn,
    database,
    sql,
    parameters,
    transactionId,
    formatRecordsAs: "JSON",
  }));
}

function statementsFrom(sql) {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
}

async function appliedNames() {
  await exec(`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`);
  const result = await exec("select name from schema_migrations");
  return new Set(JSON.parse(result.formattedRecords || "[]").map((row) => row.name));
}

export async function handler() {
  const dir = path.dirname(new URL(import.meta.url).pathname);
  const files = fs.readdirSync(dir)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort();

  const applied = await appliedNames();

  for (const file of files) {
    if (applied.has(file)) continue;

    const transaction = await rds.send(new BeginTransactionCommand({
      resourceArn,
      secretArn,
      database,
    }));
    const transactionId = transaction.transactionId;
    if (!transactionId) throw new Error("Could not begin schema migration transaction");

    try {
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      for (const statement of statementsFrom(sql)) {
        await exec(statement, [], transactionId);
      }
      await exec(
        "insert into schema_migrations(name) values (:name)",
        [{ name: "name", value: { stringValue: file } }],
        transactionId,
      );
      await rds.send(new CommitTransactionCommand({
        resourceArn,
        secretArn,
        transactionId,
      }));
    } catch (error) {
      await rds.send(new RollbackTransactionCommand({
        resourceArn,
        secretArn,
        transactionId,
      })).catch(() => {});
      throw error;
    }
  }

  return {
    PhysicalResourceId: "ginger-dragon-schema",
    Data: { AppliedThrough: files.at(-1) || "none" },
  };
}

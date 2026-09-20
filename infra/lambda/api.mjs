import {
  BeginTransactionCommand,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  RDSDataClient,
  RollbackTransactionCommand,
} from "@aws-sdk/client-rds-data";
import { randomBytes, randomUUID } from "node:crypto";

const rds = new RDSDataClient({});
const resourceArn = process.env.DB_CLUSTER_ARN;
const secretArn = process.env.DB_SECRET_ARN;
const database = process.env.DB_NAME || "gingerdragon";

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify(body),
});

const badRequest = (message) => json(400, { error: "bad_request", message });
const forbidden = () => json(403, { error: "forbidden", message: "Not allowed" });
const notFound = () => json(404, { error: "not_found", message: "Not found" });

function claims(event) {
  return event?.requestContext?.authorizer?.jwt?.claims || {};
}

function userSub(event) {
  const sub = claims(event).sub;
  if (!sub) throw new Error("Missing authenticated Cognito subject");
  return String(sub);
}

function userEmail(event) {
  return String(claims(event).email || "");
}

function parseBody(event) {
  if (!event?.body) return {};
  try {
    return JSON.parse(event.body);
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

function valueParam(name, value) {
  if (value === null || value === undefined) return { name, value: { isNull: true } };
  if (typeof value === "boolean") return { name, value: { booleanValue: value } };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { name, value: { longValue: value } }
      : { name, value: { doubleValue: value } };
  }
  return { name, value: { stringValue: String(value) } };
}

async function exec(sql, params = [], transactionId) {
  const response = await rds.send(new ExecuteStatementCommand({
    resourceArn,
    secretArn,
    database,
    sql,
    parameters: params,
    transactionId,
    formatRecordsAs: "JSON",
    includeResultMetadata: true,
  }));
  if (!response.formattedRecords) return [];
  return JSON.parse(response.formattedRecords);
}

function toPublicUser(row, email) {
  if (!row) return null;
  return {
    id: row.cognito_sub,
    email: row.email || email || "",
    role: row.role || "user",
    active_character_id: row.active_character_id || null,
    settings: row.settings || {},
    created_date: row.created_at,
    updated_date: row.updated_at,
  };
}

function toCharacter(row) {
  if (!row) return null;
  const { owner_sub, created_at, updated_at, portrait_key, ...rest } = row;
  return {
    ...rest,
    created_by_id: owner_sub,
    created_date: created_at,
    updated_date: updated_at,
    portrait_url: rest.portrait_url || portrait_key || "",
  };
}

function toCampaign(row) {
  if (!row) return null;
  const { owner_sub, created_at, updated_at, join_code_hash, ...rest } = row;
  return {
    ...rest,
    created_by_id: owner_sub,
    created_date: created_at,
    updated_date: updated_at,
  };
}

const characterFields = {
  name: "text",
  ruleset: "text",
  system_key: "text",
  rules_profile_id: "text",
  profile_version: "number",
  schema_version: "number",
  legacy_profile: "boolean",
  character_source: "text",
  source_template_id: "text",
  ruleset_data: "json",
  quote: "text",
  draft: "boolean",
  creation_step: "text",
  portrait_url: "text",
  portrait_settings: "json",
  customization: "json",
  details: "json",
  attributes: "json",
  skills: "json",
  health: "number",
  max_health: "number",
  mana: "number",
  max_mana: "number",
  ai_favor: "number",
  status_effects: "text",
  visible_to: "json",
  campaign_id: "text",
  defense: "json",
  equipment: "json",
  currency: "json",
  attacks: "json",
  spells: "json",
  hotbar: "json",
  inventory: "json",
  notes: "text",
};

const campaignFields = {
  name: "text",
  party: "json",
  members: "json",
  active: "boolean",
  description: "text",
  current_floor: "text",
  join_code: "text",
  last_played: "timestamp",
  archived: "boolean",
};

function normalizeField(type, value) {
  if (type === "json") return JSON.stringify(value ?? (Array.isArray(value) ? [] : {}));
  if (type === "boolean") return Boolean(value);
  if (type === "number") return Number(value ?? 0);
  if (type === "timestamp") return value ? String(value) : null;
  return value == null ? "" : String(value);
}

function buildPatch(payload, fields) {
  const sets = [];
  const params = [];
  let i = 0;
  for (const [key, type] of Object.entries(fields)) {
    if (!(key in payload)) continue;
    const param = `p${i++}`;
    if (type === "json") {
      sets.push(`${key} = cast(:${param} as jsonb)`);
    } else if (type === "timestamp") {
      sets.push(`${key} = cast(:${param} as timestamptz)`);
    } else {
      sets.push(`${key} = :${param}`);
    }
    params.push(valueParam(param, normalizeField(type, payload[key])));
  }
  return { sets, params };
}

async function ensureUser(event) {
  const sub = userSub(event);
  const email = userEmail(event);
  const rows = await exec(
    `insert into app_users (cognito_sub, email)
     values (:sub, :email)
     on conflict (cognito_sub)
     do update set email = excluded.email, updated_at = now()
     returning *`,
    [valueParam("sub", sub), valueParam("email", email)],
  );
  return rows[0];
}

async function handleMe(event, method) {
  const sub = userSub(event);
  const email = userEmail(event);
  const current = await ensureUser(event);
  if (method === "GET") return json(200, toPublicUser(current, email));

  const body = parseBody(event);
  const sets = [];
  const params = [valueParam("sub", sub)];

  if ("active_character_id" in body) {
    if (body.active_character_id) {
      const owned = await exec(
        "select id from characters where id = cast(:id as uuid) and owner_sub = :sub limit 1",
        [valueParam("id", body.active_character_id), valueParam("sub", sub)],
      );
      if (!owned.length) return badRequest("Active character must belong to the signed-in user");
      sets.push("active_character_id = cast(:active_character_id as uuid)");
      params.push(valueParam("active_character_id", body.active_character_id));
    } else {
      sets.push("active_character_id = null");
    }
  }

  if ("settings" in body) {
    sets.push("settings = cast(:settings as jsonb)");
    params.push(valueParam("settings", JSON.stringify(body.settings || {})));
  }

  if (!sets.length) return json(200, toPublicUser(current, email));

  sets.push("updated_at = now()");
  const rows = await exec(
    `update app_users set ${sets.join(", ")} where cognito_sub = :sub returning *`,
    params,
  );
  return json(200, toPublicUser(rows[0], email));
}

async function listCharacters(event) {
  const sub = userSub(event);
  const rows = await exec(
    `select * from characters
     where owner_sub = :sub
        or visible_to @> cast(:visible as jsonb)
     order by updated_at desc
     limit 200`,
    [valueParam("sub", sub), valueParam("visible", JSON.stringify([sub]))],
  );
  return json(200, rows.map(toCharacter));
}

async function createCharacter(event) {
  const sub = userSub(event);
  const body = parseBody(event);
  const id = randomUUID();
  const { sets, params } = buildPatch(body, characterFields);

  const columns = ["id", "owner_sub"];
  const values = ["cast(:id as uuid)", ":sub"];
  const insertParams = [valueParam("id", id), valueParam("sub", sub)];

  for (let i = 0; i < sets.length; i++) {
    const assignment = sets[i];
    const [column, rhs] = assignment.split(" = ");
    columns.push(column);
    values.push(rhs);
    insertParams.push(params[i]);
  }

  const rows = await exec(
    `insert into characters (${columns.join(", ")})
     values (${values.join(", ")})
     returning *`,
    insertParams,
  );
  return json(201, toCharacter(rows[0]));
}

async function getCharacter(event) {
  const sub = userSub(event);
  const id = event.pathParameters?.id || "";
  const rows = await exec(
    `select * from characters
     where id = cast(:id as uuid)
       and (owner_sub = :sub or visible_to @> cast(:visible as jsonb))
     limit 1`,
    [
      valueParam("id", id),
      valueParam("sub", sub),
      valueParam("visible", JSON.stringify([sub])),
    ],
  );
  return rows.length ? json(200, toCharacter(rows[0])) : notFound();
}

async function patchCharacter(event) {
  const sub = userSub(event);
  const id = event.pathParameters?.id || "";
  const body = parseBody(event);
  const { sets, params } = buildPatch(body, characterFields);
  if (!sets.length) return getCharacter(event);

  sets.push("updated_at = now()");
  params.push(valueParam("id", id), valueParam("sub", sub));
  const rows = await exec(
    `update characters
     set ${sets.join(", ")}
     where id = cast(:id as uuid) and owner_sub = :sub
     returning *`,
    params,
  );
  return rows.length ? json(200, toCharacter(rows[0])) : forbidden();
}

async function deleteCharacter(event) {
  const sub = userSub(event);
  const id = event.pathParameters?.id || "";
  const rows = await exec(
    `delete from characters
     where id = cast(:id as uuid) and owner_sub = :sub
     returning id`,
    [valueParam("id", id), valueParam("sub", sub)],
  );
  return rows.length ? json(200, { id, deleted: true }) : forbidden();
}

async function listCampaigns(event) {
  const sub = userSub(event);
  const rows = await exec(
    `select * from campaigns
     where owner_sub = :sub
        or members @> cast(:member as jsonb)
     order by updated_at desc
     limit 100`,
    [valueParam("sub", sub), valueParam("member", JSON.stringify([sub]))],
  );
  return json(200, rows.map(toCampaign));
}

async function createCampaign(event) {
  const sub = userSub(event);
  const body = parseBody(event);
  if (!String(body.name || "").trim()) return badRequest("Campaign name is required");

  const id = randomUUID();
  const payload = {
    ...body,
    members: Array.from(new Set([sub, ...(Array.isArray(body.members) ? body.members : [])])),
  };
  const { sets, params } = buildPatch(payload, campaignFields);

  const columns = ["id", "owner_sub"];
  const values = ["cast(:id as uuid)", ":sub"];
  const insertParams = [valueParam("id", id), valueParam("sub", sub)];

  for (let i = 0; i < sets.length; i++) {
    const assignment = sets[i];
    const [column, rhs] = assignment.split(" = ");
    columns.push(column);
    values.push(rhs);
    insertParams.push(params[i]);
  }

  const rows = await exec(
    `insert into campaigns (${columns.join(", ")})
     values (${values.join(", ")})
     returning *`,
    insertParams,
  );
  return json(201, toCampaign(rows[0]));
}

async function getCampaign(event) {
  const sub = userSub(event);
  const id = event.pathParameters?.id || "";
  const rows = await exec(
    `select * from campaigns
     where id = cast(:id as uuid)
       and (owner_sub = :sub or members @> cast(:member as jsonb))
     limit 1`,
    [
      valueParam("id", id),
      valueParam("sub", sub),
      valueParam("member", JSON.stringify([sub])),
    ],
  );
  return rows.length ? json(200, toCampaign(rows[0])) : notFound();
}

async function patchCampaign(event) {
  const sub = userSub(event);
  const id = event.pathParameters?.id || "";
  const body = parseBody(event);
  const { sets, params } = buildPatch(body, campaignFields);
  if (!sets.length) return getCampaign(event);

  sets.push("updated_at = now()");
  params.push(valueParam("id", id), valueParam("sub", sub));
  const rows = await exec(
    `update campaigns
     set ${sets.join(", ")}
     where id = cast(:id as uuid) and owner_sub = :sub
     returning *`,
    params,
  );
  return rows.length ? json(200, toCampaign(rows[0])) : forbidden();
}

async function deleteCampaign(event) {
  const sub = userSub(event);
  const id = event.pathParameters?.id || "";
  const rows = await exec(
    `delete from campaigns
     where id = cast(:id as uuid) and owner_sub = :sub
     returning id`,
    [valueParam("id", id), valueParam("sub", sub)],
  );
  return rows.length ? json(200, { id, deleted: true }) : forbidden();
}



function toNote(row) {
  if (!row) return null;
  const { owner_sub, created_at, updated_at, sketch_key, ...rest } = row;
  return {
    ...rest,
    created_by_id: owner_sub,
    created_date: created_at,
    updated_date: updated_at,
    sketch_url: rest.sketch_url || sketch_key || "",
  };
}

function toSession(row) {
  if (!row) return null;
  const { owner_sub, created_at, session_date, ...rest } = row;
  return {
    ...rest,
    date: session_date || "",
    created_by_id: owner_sub,
    created_date: created_at,
    updated_date: created_at,
  };
}

async function listNotes(event) {
  const sub = userSub(event);
  const rows = await exec(
    "select * from gm_notes where owner_sub = :sub order by updated_at desc limit 200",
    [valueParam("sub", sub)],
  );
  return json(200, rows.map(toNote));
}

async function createNote(event) {
  const sub = userSub(event);
  const body = parseBody(event);
  const id = randomUUID();
  const scope = body.scope === "campaign" ? "campaign" : "personal";
  const campaignId = String(body.campaign_id || "").trim();

  if (scope === "campaign" && campaignId) {
    const campaign = await visibleCampaignForUser(campaignId, sub);
    if (!campaign) return forbidden();
  }

  const rows = await exec(
    `insert into gm_notes
      (id, owner_sub, content, scope, campaign_id, sketch_url)
     values
      (cast(:id as uuid), :sub, :content, :scope,
       ${campaignId ? "cast(:campaign_id as uuid)" : "null"}, :sketch_url)
     returning *`,
    [
      valueParam("id", id),
      valueParam("sub", sub),
      valueParam("content", String(body.content || "").slice(0, 100000)),
      valueParam("scope", scope),
      ...(campaignId ? [valueParam("campaign_id", campaignId)] : []),
      valueParam("sketch_url", String(body.sketch_url || "")),
    ],
  );
  return json(201, toNote(rows[0]));
}

async function patchNote(event) {
  const sub = userSub(event);
  const id = String(event.pathParameters?.id || "");
  const body = parseBody(event);
  const sets = [];
  const params = [valueParam("id", id), valueParam("sub", sub)];

  if ("content" in body) {
    sets.push("content = :content");
    params.push(valueParam("content", String(body.content || "").slice(0, 100000)));
  }
  if ("scope" in body) {
    sets.push("scope = :scope");
    params.push(valueParam("scope", body.scope === "campaign" ? "campaign" : "personal"));
  }
  if ("sketch_url" in body) {
    sets.push("sketch_url = :sketch_url");
    params.push(valueParam("sketch_url", String(body.sketch_url || "")));
  }
  if ("campaign_id" in body) {
    const campaignId = String(body.campaign_id || "").trim();
    if (campaignId) {
      const campaign = await visibleCampaignForUser(campaignId, sub);
      if (!campaign) return forbidden();
      sets.push("campaign_id = cast(:campaign_id as uuid)");
      params.push(valueParam("campaign_id", campaignId));
    } else {
      sets.push("campaign_id = null");
    }
  }
  if (!sets.length) return badRequest("No supported fields were supplied");

  sets.push("updated_at = now()");
  const rows = await exec(
    `update gm_notes set ${sets.join(", ")}
     where id = cast(:id as uuid) and owner_sub = :sub
     returning *`,
    params,
  );
  return rows.length ? json(200, toNote(rows[0])) : notFound();
}

async function deleteNote(event) {
  const sub = userSub(event);
  const id = String(event.pathParameters?.id || "");
  const rows = await exec(
    "delete from gm_notes where id = cast(:id as uuid) and owner_sub = :sub returning id",
    [valueParam("id", id), valueParam("sub", sub)],
  );
  return rows.length ? json(200, { id, deleted: true }) : notFound();
}

async function listSessions(event) {
  const sub = userSub(event);
  const rows = await exec(
    "select * from sessions where owner_sub = :sub order by created_at desc limit 200",
    [valueParam("sub", sub)],
  );
  return json(200, rows.map(toSession));
}

async function rawCampaign(id) {
  const rows = await exec(
    "select * from campaigns where id = cast(:id as uuid) limit 1",
    [valueParam("id", id)],
  );
  return rows[0] || null;
}

async function rawCharacter(id) {
  const rows = await exec(
    "select * from characters where id = cast(:id as uuid) limit 1",
    [valueParam("id", id)],
  );
  return rows[0] || null;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

async function servicePatchCampaign(id, patch) {
  const { sets, params } = buildPatch(patch, campaignFields);
  if (!sets.length) return rawCampaign(id);
  sets.push("updated_at = now()");
  params.push(valueParam("id", id));
  const rows = await exec(
    `update campaigns set ${sets.join(", ")}
     where id = cast(:id as uuid) returning *`,
    params,
  );
  return rows[0] || null;
}

async function servicePatchCharacter(id, patch) {
  const { sets, params } = buildPatch(patch, characterFields);
  if (!sets.length) return rawCharacter(id);
  sets.push("updated_at = now()");
  params.push(valueParam("id", id));
  const rows = await exec(
    `update characters set ${sets.join(", ")}
     where id = cast(:id as uuid) returning *`,
    params,
  );
  return rows[0] || null;
}

async function visibleCampaignForUser(id, sub) {
  const rows = await exec(
    `select * from campaigns
     where id = cast(:id as uuid)
       and (owner_sub = :sub or members @> cast(:member as jsonb))
     limit 1`,
    [
      valueParam("id", id),
      valueParam("sub", sub),
      valueParam("member", JSON.stringify([sub])),
    ],
  );
  return rows[0] || null;
}

function campaignSummary(campaign) {
  return campaign ? { id: campaign.id, name: campaign.name || "" } : null;
}

async function actionJoinCampaign(event, body) {
  const sub = userSub(event);
  const code = String(body?.join_code || "").trim().toUpperCase();
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  if (!code) return { error: "A join code is required." };
  if (![6, 8].includes(code.length) || [...code].some((ch) => !alphabet.includes(ch))) {
    return { ok: false, error: "That code is not valid." };
  }

  const found = await exec(
    "select * from campaigns where join_code = :code and archived = false limit 1",
    [valueParam("code", code)],
  );
  const campaign = found[0];
  if (!campaign) return { ok: false, error: "That code matches no campaign." };

  let members = array(campaign.members);
  const isNew = campaign.owner_sub !== sub && !members.includes(sub);
  if (isNew) {
    members = [...members, sub];
    await servicePatchCampaign(campaign.id, { members });

    for (const characterId of array(campaign.party)) {
      const character = await rawCharacter(characterId);
      if (!character) continue;
      const visibleTo = array(character.visible_to);
      if (!visibleTo.includes(sub)) {
        await servicePatchCharacter(characterId, { visible_to: [...visibleTo, sub] });
      }
    }
  }

  const owned = await exec(
    `select * from characters
     where campaign_id = :campaign_id and owner_sub = :sub
     order by updated_at desc limit 1`,
    [valueParam("campaign_id", campaign.id), valueParam("sub", sub)],
  );
  const selected = owned[0] || null;
  let character = null;

  if (selected) {
    const latestCampaign = await rawCampaign(campaign.id);
    const party = array(latestCampaign?.party);
    if (!party.includes(selected.id)) {
      await servicePatchCampaign(campaign.id, { party: [...party, selected.id] });
    }

    const viewers = new Set([
      ...members,
      campaign.owner_sub,
      ...array(selected.visible_to),
    ].filter(Boolean));
    await servicePatchCharacter(selected.id, { visible_to: [...viewers] });
    character = { id: selected.id, name: selected.name || "" };
  }

  return { ok: true, campaign: campaignSummary(campaign), character };
}

async function actionAddCharacterToCampaign(event, body) {
  const sub = userSub(event);
  const characterId = String(body?.character_id || "").trim();
  if (!characterId) return { error: "character_id is required." };

  const character = await rawCharacter(characterId);
  if (!character || character.owner_sub !== sub) {
    return { ok: false, reason: "not_your_character" };
  }

  let campaign = null;
  if (body?.campaign_id) {
    campaign = await visibleCampaignForUser(String(body.campaign_id), sub);
    if (campaign?.archived) campaign = null;
  } else {
    const rows = await exec(
      `select * from campaigns
       where active = true and archived = false
         and (owner_sub = :sub or members @> cast(:member as jsonb))
       order by updated_at desc limit 1`,
      [valueParam("sub", sub), valueParam("member", JSON.stringify([sub]))],
    );
    campaign = rows[0] || null;
  }
  if (!campaign) return { ok: false, reason: "no_active_campaign" };

  const members = array(campaign.members);
  if (campaign.owner_sub !== sub && !members.includes(sub)) {
    return { ok: false, reason: "not_a_member" };
  }

  let currentVisible = array(character.visible_to);
  const oldCampaignId = String(character.campaign_id || "").trim();
  if (oldCampaignId && oldCampaignId !== campaign.id) {
    const oldCampaign = await rawCampaign(oldCampaignId);
    if (oldCampaign) {
      await servicePatchCampaign(oldCampaign.id, {
        party: array(oldCampaign.party).filter((id) => id !== characterId),
      });
      const oldReaders = new Set([oldCampaign.owner_sub, ...array(oldCampaign.members)].filter(Boolean));
      currentVisible = currentVisible.filter((id) => !oldReaders.has(id));
    }
  }

  const party = array(campaign.party);
  if (!party.includes(characterId)) {
    await servicePatchCampaign(campaign.id, { party: [...party, characterId] });
  }

  const viewers = new Set([
    ...currentVisible,
    ...members,
    campaign.owner_sub,
  ].filter(Boolean));
  await servicePatchCharacter(characterId, {
    campaign_id: campaign.id,
    visible_to: [...viewers],
  });

  return { ok: true, campaign: campaignSummary(campaign) };
}

async function actionRemoveCharacterFromCampaign(event, body) {
  const sub = userSub(event);
  const campaignId = String(body?.campaign_id || "").trim();
  const characterId = String(body?.character_id || "").trim();
  if (!campaignId || !characterId) {
    return { error: "campaign_id and character_id are required." };
  }

  const campaign = await visibleCampaignForUser(campaignId, sub);
  if (!campaign) return { error: "Campaign not found." };
  const character = await rawCharacter(characterId);
  if (!character) return { error: "Character not found." };

  const isCampaignOwner = campaign.owner_sub === sub;
  const isCharacterOwner = character.owner_sub === sub;
  if (!isCampaignOwner && !isCharacterOwner) {
    const error = new Error("Not allowed to remove this character.");
    error.status = 403;
    throw error;
  }

  await servicePatchCampaign(campaignId, {
    party: array(campaign.party).filter((id) => id !== characterId),
  });

  if (String(character.campaign_id || "") === campaignId) {
    const readers = new Set([campaign.owner_sub, ...array(campaign.members)].filter(Boolean));
    await servicePatchCharacter(characterId, {
      campaign_id: "",
      visible_to: array(character.visible_to).filter((id) => !readers.has(id)),
    });
  }
  return { ok: true };
}

async function actionRemoveCampaignMember(event, body) {
  const sub = userSub(event);
  const campaignId = String(body?.campaign_id || "").trim();
  const removeSub = String(body?.user_id || "").trim();
  if (!campaignId || !removeSub) {
    return { error: "campaign_id and user_id are required." };
  }

  const campaign = await visibleCampaignForUser(campaignId, sub);
  if (!campaign) return { ok: false, error: "Campaign not found." };
  if (campaign.owner_sub !== sub) {
    const error = new Error("Only the campaign owner can remove members.");
    error.status = 403;
    throw error;
  }

  const members = array(campaign.members);
  if (!members.includes(removeSub)) return { ok: true };

  const keptParty = [];
  for (const characterId of array(campaign.party)) {
    const character = await rawCharacter(characterId);
    if (character?.owner_sub === removeSub) continue;
    keptParty.push(characterId);
    if (character) {
      await servicePatchCharacter(characterId, {
        visible_to: array(character.visible_to).filter((id) => id !== removeSub),
      });
    }
  }

  await servicePatchCampaign(campaignId, {
    members: members.filter((id) => id !== removeSub),
    party: keptParty,
  });

  const campaignReaders = new Set([campaign.owner_sub, ...members].filter(Boolean));
  const owned = await exec(
    "select * from characters where campaign_id = :campaign_id and owner_sub = :owner_sub",
    [valueParam("campaign_id", campaignId), valueParam("owner_sub", removeSub)],
  );
  for (const character of owned) {
    await servicePatchCharacter(character.id, {
      campaign_id: "",
      visible_to: array(character.visible_to).filter((id) => !campaignReaders.has(id)),
    });
  }

  return { ok: true };
}

async function actionLeaveCampaign(event, body) {
  const sub = userSub(event);
  const campaignId = String(body?.campaign_id || "").trim();
  if (!campaignId) return { error: "campaign_id is required." };

  const campaign = await visibleCampaignForUser(campaignId, sub);
  if (!campaign) return { ok: false, error: "Campaign not found." };
  if (campaign.owner_sub === sub) {
    const error = new Error("The campaign owner cannot leave their own campaign.");
    error.status = 403;
    throw error;
  }

  const members = array(campaign.members);
  if (!members.includes(sub)) return { ok: true };

  const keptParty = [];
  for (const characterId of array(campaign.party)) {
    const character = await rawCharacter(characterId);
    if (character?.owner_sub === sub) continue;
    keptParty.push(characterId);
    if (character) {
      await servicePatchCharacter(characterId, {
        visible_to: array(character.visible_to).filter((id) => id !== sub),
      });
    }
  }

  await servicePatchCampaign(campaignId, {
    members: members.filter((id) => id !== sub),
    party: keptParty,
  });

  const campaignReaders = new Set([campaign.owner_sub, ...members].filter(Boolean));
  const owned = await exec(
    "select * from characters where campaign_id = :campaign_id and owner_sub = :owner_sub",
    [valueParam("campaign_id", campaignId), valueParam("owner_sub", sub)],
  );
  for (const character of owned) {
    await servicePatchCharacter(character.id, {
      campaign_id: "",
      visible_to: array(character.visible_to).filter((id) => !campaignReaders.has(id)),
    });
  }

  return { ok: true };
}

function finiteInt(value, min, max) {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

async function actionPatchCampaignCharacter(event, body) {
  const sub = userSub(event);
  const campaignId = String(body?.campaign_id || "").trim();
  const characterId = String(body?.character_id || "").trim();
  if (!campaignId || !characterId) {
    return { error: "campaign_id and character_id are required." };
  }

  const campaign = await visibleCampaignForUser(campaignId, sub);
  if (!campaign || campaign.archived) return { error: "Campaign not found." };
  if (!array(campaign.party).includes(characterId)) {
    const error = new Error("Character is not in this campaign party.");
    error.status = 403;
    throw error;
  }

  const character = await rawCharacter(characterId);
  if (!character) return { error: "Character not found." };
  if (character.owner_sub !== sub && campaign.owner_sub !== sub) {
    const error = new Error("Only the character owner or campaign GM can edit live party state.");
    error.status = 403;
    throw error;
  }

  const requested = body?.fields && typeof body.fields === "object" ? body.fields : {};
  const patch = {};
  if ("health" in requested) {
    const max = Math.max(0, Number(character.max_health) || 0);
    const n = finiteInt(requested.health, 0, max || 1000000);
    if (n !== null) patch.health = n;
  }
  if ("mana" in requested) {
    const max = Math.max(0, Number(character.max_mana) || 0);
    const n = finiteInt(requested.mana, 0, max || 1000000);
    if (n !== null) patch.mana = n;
  }
  if ("ai_favor" in requested) {
    const n = finiteInt(requested.ai_favor, 0, 1000000);
    if (n !== null) patch.ai_favor = n;
  }
  if ("status_effects" in requested) {
    patch.status_effects = String(requested.status_effects || "").slice(0, 500);
  }
  if (!Object.keys(patch).length) return { error: "No permitted fields were supplied." };

  const updated = await servicePatchCharacter(characterId, patch);
  return { ok: true, character: toCharacter(updated) };
}

async function actionCampaignInviteCode(event, body) {
  const sub = userSub(event);
  const campaignId = String(body?.campaign_id || "").trim();
  const action = String(body?.action || "generate");
  if (!campaignId) return { error: "campaign_id is required." };

  const campaign = await visibleCampaignForUser(campaignId, sub);
  if (!campaign) return { ok: false, error: "Campaign not found." };
  if (campaign.owner_sub !== sub) {
    const error = new Error("Only the campaign owner can manage invite codes.");
    error.status = 403;
    throw error;
  }

  if (action === "revoke") {
    await servicePatchCampaign(campaignId, { join_code: "" });
    return { ok: true, join_code: "" };
  }

  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 12; attempt++) {
    const bytes = randomBytes(8);
    let code = "";
    for (const byte of bytes) code += alphabet[byte % alphabet.length];
    const taken = await exec(
      "select id from campaigns where join_code = :code limit 1",
      [valueParam("code", code)],
    );
    if (taken.length) continue;
    await servicePatchCampaign(campaignId, { join_code: code });
    return { ok: true, join_code: code };
  }
  throw new Error("Could not generate a unique code — please try again.");
}


function capNum(value, max = 10000000) {
  const n = Number.parseInt(String(value ?? 0), 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0;
}

function capText(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

async function actionSaveCampaignSession(event, body) {
  const sub = userSub(event);
  const campaignId = String(body?.campaign_id || "").trim();
  if (!campaignId) return { error: "campaign_id is required." };

  const campaign = await visibleCampaignForUser(campaignId, sub);
  if (!campaign || campaign.archived) return { error: "Campaign not found." };
  if (campaign.owner_sub !== sub) {
    const error = new Error("Only the campaign owner can save a session.");
    error.status = 403;
    throw error;
  }

  const partyIds = new Set(array(campaign.party));
  const requested = Array.isArray(body.present) ? body.present.slice(0, 100) : [];
  if (!requested.length) return { error: "At least one party character must be present." };

  const statEntries = [];
  for (const row of requested) {
    const characterId = String(row?.character_id || "").trim();
    if (!characterId || !partyIds.has(characterId)) {
      return { error: "Session contains a character outside this campaign party." };
    }
    const character = await rawCharacter(characterId);
    if (!character) return { error: "A party character could not be found." };
    statEntries.push({
      character_id: characterId,
      name: capText(character.name || "Unnamed Crawler", 120),
      damage_dealt: capNum(row?.damage_dealt),
      healing_done: capNum(row?.healing_done),
      kills: capNum(row?.kills),
      deaths: capNum(row?.deaths),
      crit_successes: capNum(row?.crit_successes),
      crit_failures: capNum(row?.crit_failures),
    });
  }

  const begin = await rds.send(new BeginTransactionCommand({
    resourceArn,
    secretArn,
    database,
  }));
  const transactionId = begin.transactionId;
  if (!transactionId) throw new Error("Could not begin session transaction");

  try {
    const counts = await exec(
      "select count(*)::int as count from sessions where campaign_id = cast(:campaign_id as uuid)",
      [valueParam("campaign_id", campaignId)],
      transactionId,
    );
    const sessionNumber = Number(counts?.[0]?.count || 0) + 1;
    const sessionId = randomUUID();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || "")) ? String(body.date) : "";

    const sessions = await exec(
      `insert into sessions
        (id, owner_sub, campaign_id, campaign_name, session_number, session_date,
         floor, duration_minutes, present, stats, ai_favor_earned, ai_favor_spent,
         highlights, gm_notes)
       values
        (cast(:id as uuid), :owner_sub, cast(:campaign_id as uuid), :campaign_name,
         :session_number, :session_date, :floor, :duration_minutes,
         cast(:present as jsonb), cast(:stats as jsonb), :ai_favor_earned,
         :ai_favor_spent, :highlights, :gm_notes)
       returning *`,
      [
        valueParam("id", sessionId),
        valueParam("owner_sub", sub),
        valueParam("campaign_id", campaignId),
        valueParam("campaign_name", capText(campaign.name, 160)),
        valueParam("session_number", sessionNumber),
        valueParam("session_date", date),
        valueParam("floor", capText(body.floor, 120)),
        valueParam("duration_minutes", capNum(body.duration_minutes, 10080)),
        valueParam("present", JSON.stringify(statEntries.map((row) => ({
          character_id: row.character_id,
          name: row.name,
        })))),
        valueParam("stats", JSON.stringify(statEntries)),
        valueParam("ai_favor_earned", capNum(body.ai_favor_earned, 1000000)),
        valueParam("ai_favor_spent", capNum(body.ai_favor_spent, 1000000)),
        valueParam("highlights", capText(body.highlights, 5000)),
        valueParam("gm_notes", capText(body.gm_notes, 10000)),
      ],
      transactionId,
    );

    for (const row of statEntries) {
      await exec(
        `insert into campaign_stats
          (campaign_id, character_id, damage_dealt, healing_done, kills, deaths,
           crit_successes, crit_failures, sessions_played)
         values
          (cast(:campaign_id as uuid), cast(:character_id as uuid), :damage_dealt,
           :healing_done, :kills, :deaths, :crit_successes, :crit_failures, 1)
         on conflict (campaign_id, character_id)
         do update set
           damage_dealt = excluded.damage_dealt,
           healing_done = excluded.healing_done,
           kills = excluded.kills,
           deaths = excluded.deaths,
           crit_successes = excluded.crit_successes,
           crit_failures = excluded.crit_failures,
           sessions_played = campaign_stats.sessions_played + 1`,
        [
          valueParam("campaign_id", campaignId),
          valueParam("character_id", row.character_id),
          valueParam("damage_dealt", row.damage_dealt),
          valueParam("healing_done", row.healing_done),
          valueParam("kills", row.kills),
          valueParam("deaths", row.deaths),
          valueParam("crit_successes", row.crit_successes),
          valueParam("crit_failures", row.crit_failures),
        ],
        transactionId,
      );
    }

    await rds.send(new CommitTransactionCommand({
      resourceArn,
      secretArn,
      transactionId,
    }));

    return { ok: true, session: toSession(sessions[0]) };
  } catch (error) {
    await rds.send(new RollbackTransactionCommand({
      resourceArn,
      secretArn,
      transactionId,
    })).catch(() => {});
    throw error;
  }
}

async function actionGetCampaignStats(event, body) {
  const sub = userSub(event);
  const campaignId = String(body?.campaign_id || "").trim();
  if (!campaignId) return { error: "campaign_id is required." };
  const campaign = await visibleCampaignForUser(campaignId, sub);
  if (!campaign || campaign.archived) return { error: "Campaign not found." };

  const ids = new Set(array(campaign.party));
  const rows = await exec(
    "select * from campaign_stats where campaign_id = cast(:campaign_id as uuid)",
    [valueParam("campaign_id", campaignId)],
  );
  return { ok: true, rows: rows.filter((row) => ids.has(row.character_id)) };
}

async function invokeAction(event) {
  const name = String(event.pathParameters?.name || "");
  const body = parseBody(event);
  const actions = {
    joinCampaign: actionJoinCampaign,
    addCharacterToCampaign: actionAddCharacterToCampaign,
    removeCharacterFromCampaign: actionRemoveCharacterFromCampaign,
    removeCampaignMember: actionRemoveCampaignMember,
    leaveCampaign: actionLeaveCampaign,
    patchCampaignCharacter: actionPatchCampaignCharacter,
    campaignInviteCode: actionCampaignInviteCode,
    getCampaignStats: actionGetCampaignStats,
    saveCampaignSession: actionSaveCampaignSession,
  };
  const action = actions[name];
  if (!action) return notFound();
  const data = await action(event, body);
  return json(data?.error && !data?.ok ? 400 : 200, data);
}

export async function handler(event) {
  try {
    const method = event?.requestContext?.http?.method || "";
    const path = event?.rawPath || "";

    if (method === "GET" && path === "/health") {
      return json(200, { ok: true, service: "ginger-dragon-api" });
    }

    if (path === "/me" && (method === "GET" || method === "PATCH")) {
      return await handleMe(event, method);
    }

    if (path === "/characters" && method === "GET") return await listCharacters(event);
    if (path === "/characters" && method === "POST") return await createCharacter(event);
    if (path.startsWith("/characters/") && method === "GET") return await getCharacter(event);
    if (path.startsWith("/characters/") && method === "PATCH") return await patchCharacter(event);
    if (path.startsWith("/characters/") && method === "DELETE") return await deleteCharacter(event);

    if (path === "/gm-notes" && method === "GET") return await listNotes(event);
    if (path === "/gm-notes" && method === "POST") return await createNote(event);
    if (path.startsWith("/gm-notes/") && method === "PATCH") return await patchNote(event);
    if (path.startsWith("/gm-notes/") && method === "DELETE") return await deleteNote(event);
    if (path === "/sessions" && method === "GET") return await listSessions(event);

    if (path.startsWith("/actions/") && method === "POST") return await invokeAction(event);

    if (path === "/campaigns" && method === "GET") return await listCampaigns(event);
    if (path === "/campaigns" && method === "POST") return await createCampaign(event);
    if (path.startsWith("/campaigns/") && method === "GET") return await getCampaign(event);
    if (path.startsWith("/campaigns/") && method === "PATCH") return await patchCampaign(event);
    if (path.startsWith("/campaigns/") && method === "DELETE") return await deleteCampaign(event);

    return notFound();
  } catch (error) {
    console.error("Unhandled API error", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    if (message.includes("valid JSON")) return badRequest(message);
    return json(500, { error: "internal_error", message: "Request failed" });
  }
}

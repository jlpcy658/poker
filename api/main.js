const kv = await Deno.openKv();

const SYNC_VIEW_SCHEMA_VERSION = 7;
const primaryOrigin = "https://jlpcy658.github.io";
const devOrigin = "http://127.0.0.1:5500";

const STATE_TTL = 86_400_000;
const ACTION_TTL = 120_000;

const allowedActionNames = new Set(["fold", "check", "call", "raise", "allin"]);
const allowedOrigins = new Set([
	primaryOrigin,
	devOrigin,
]);

const baseCorsHeaders = {
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
	"Access-Control-Allow-Credentials": "true",
	"Vary": "Origin",
};

/**
 * 🔥 核心修复：永远返回 CORS
 */
function withCors(origin, headers = {}) {
	return {
		...baseCorsHeaders,
		// 👉 关键：永远给，避免浏览器拦截
		"Access-Control-Allow-Origin": origin || "*",
		...headers,
	};
}

function jsonResponse(body, origin, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: withCors(origin, {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
		}),
	});
}

function textResponse(body, status, origin) {
	return new Response(body, {
		status,
		headers: withCors(origin, {
			"Content-Type": "text/plain",
			"Cache-Control": "no-store",
		}),
	});
}

function emptyResponse(origin, status = 204) {
	return new Response(null, {
		status,
		headers: withCors(origin, {
			"Cache-Control": "no-store",
		}),
	});
}

function parseInteger(value) {
	if (value === null || value === undefined || value === "") return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) ? null : parsed;
}

function getTableKey(tableId) {
	return ["table", tableId];
}

function getActionKey(tableId) {
	return ["action", tableId];
}

function findSeatView(view, seatIndex) {
	if (!view || !Array.isArray(view.seatViews)) return null;
	return view.seatViews.find((s) => s.seatIndex === seatIndex) ?? null;
}

function createSeatSyncPayload(record, seatIndex) {
	const seat = findSeatView(record?.view, seatIndex);
	if (!seat || !record?.view?.table) return null;

	return {
		table: record.view.table,
		seat,
		version: record.version,
		updatedAt: record.updatedAt,
		schemaVersion: record.schemaVersion ?? SYNC_VIEW_SCHEMA_VERSION,
	};
}

async function getState(tableId) {
	const entry = await kv.get(getTableKey(tableId));
	return entry.value ?? null;
}

async function saveState(tableId, payload) {
	const current = await getState(tableId);
	const version = (current?.version ?? 0) + 1;

	const record = {
		view: payload.view,
		updatedAt: new Date().toISOString(),
		version,
		schemaVersion: SYNC_VIEW_SCHEMA_VERSION,
	};

	await kv.set(getTableKey(tableId), record, { expireIn: STATE_TTL });
	return record;
}

async function savePendingAction(tableId, actionRequest) {
	const record = {
		seatIndex: actionRequest.seatIndex,
		turnToken: actionRequest.turnToken,
		action: actionRequest.action,
		amount: actionRequest.amount ?? null,
		createdAt: new Date().toISOString(),
	};

	await kv.set(getActionKey(tableId), record, { expireIn: ACTION_TTL });
	return record;
}

async function consumePendingAction(tableId, turnToken) {
	const key = getActionKey(tableId);
	const entry = await kv.get(key);
	const record = entry.value ?? null;

	if (!record) return null;
	if (record.turnToken !== turnToken) {
		await kv.delete(key);
		return null;
	}

	await kv.delete(key);
	return record;
}

async function handlePostState(request, origin) {
	let data;
	try {
		data = await request.json();
	} catch {
		return textResponse("Invalid JSON", 400, origin);
	}

	if (!data?.view || !data.view.table || !Array.isArray(data.view.seatViews)) {
		return textResponse("Missing view", 400, origin);
	}

	const tableId = data.tableId || "default";
	const record = await saveState(tableId, { view: data.view });

	return jsonResponse({
		ok: true,
		version: record.version,
		updatedAt: record.updatedAt,
		schemaVersion: record.schemaVersion,
	}, origin);
}

async function handleGetState(url, origin) {
	const tableId = url.searchParams.get("tableId") || "default";
	const seatIndex = parseInteger(url.searchParams.get("seatIndex"));
	const sinceVersion = Number.parseInt(url.searchParams.get("sinceVersion") || "0", 10);

	if (seatIndex === null) return textResponse("Missing seatIndex", 400, origin);

	const record = await getState(tableId);
	if (!record) return textResponse("Not found", 404, origin);

	const payload = createSeatSyncPayload(record, seatIndex);
	if (!payload) return textResponse("Seat not found", 404, origin);

	if (!Number.isNaN(sinceVersion) && record.version <= sinceVersion) {
		return emptyResponse(origin);
	}

	return jsonResponse(payload, origin);
}

async function handlePostAction(request, origin) {
	let data;
	try {
		data = await request.json();
	} catch {
		return textResponse("Invalid JSON", 400, origin);
	}

	const seatIndex = parseInteger(data?.seatIndex);
	const turnToken = data?.turnToken?.trim();
	const action = data?.action?.trim().toLowerCase();
	const amount = parseInteger(data?.amount);

	if (seatIndex === null) return textResponse("Missing seatIndex", 400, origin);
	if (!turnToken) return textResponse("Missing turnToken", 400, origin);
	if (!allowedActionNames.has(action)) return textResponse("Invalid action", 400, origin);
	if (action === "raise" && amount === null) return textResponse("Missing amount", 400, origin);

	await savePendingAction(data.tableId || "default", {
		seatIndex,
		turnToken,
		action,
		amount,
	});

	return jsonResponse({ ok: true }, origin);
}

async function handleGetAction(url, origin) {
	const tableId = url.searchParams.get("tableId") || "default";
	const turnToken = url.searchParams.get("turnToken")?.trim();

	if (!turnToken) return textResponse("Missing turnToken", 400, origin);

	const record = await consumePendingAction(tableId, turnToken);
	if (!record) return emptyResponse(origin);

	return jsonResponse(record, origin);
}

/**
 * 🔥 预检请求必须成功
 */
function handleOptions(origin) {
	return new Response(null, {
		status: 204,
		headers: withCors(origin),
	});
}

function routeRequest(request) {
	const url = new URL(request.url);
	const origin = request.headers.get("origin");

	// 👉 关键：预检必须直接放行
	if (request.method === "OPTIONS") {
		return handleOptions(origin);
	}

	// 👉 可以保留业务限制，但不会再触发 CORS 错误
	if (origin && !allowedOrigins.has(origin)) {
		return textResponse("Forbidden", 403, origin);
	}

	if (url.pathname === "/state") {
		if (request.method === "GET") return handleGetState(url, origin);
		if (request.method === "POST") return handlePostState(request, origin);
	}

	if (url.pathname === "/action") {
		if (request.method === "GET") return handleGetAction(url, origin);
		if (request.method === "POST") return handlePostAction(request, origin);
	}

	return textResponse("Not found", 404, origin);
}

Deno.serve(async (request) => {
	try {
		return await routeRequest(request);
	} catch (err) {
		console.error(err);
		return textResponse("Internal error", 500, request.headers.get("origin"));
	}
});

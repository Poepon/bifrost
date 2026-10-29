// Pure helpers behind the MCP server sheets: the state sentence and the
// duration conversions both sheets share, and the label/value rows the
// read-only view sheet shows in place of the edit sheet's form fields.

import { mcpMaxProtocolVersionLabel } from "@/lib/constants/mcp";
import type { MCPClient, MCPClientConfig, MCPClientTool } from "@/lib/types/mcp";
import type { MCPSessionKind, MCPSessionRow, MCPSessionStatus } from "@/lib/types/mcpSessions";
import {
	failureStageLabel,
	foldInstanceStates,
	formatDurationSince,
	formatFailureTiming,
	stateReasonTitle,
} from "@/lib/utils/mcpConnectionFailure";
import { perUserDiscoveryOn, supportsPerUserDiscovery } from "@/lib/utils/mcpPerUserDiscovery";
import { authTypeLabel, connectionTypeLabel } from "./mcpClientsTable.utils";

/** One label/value row of the view sheet; key is stable and names the row's test id. */
export interface MCPClientDetailRow {
	key: string;
	label: string;
	value?: string;
	note?: string;
	hint?: string;
	chips?: string[];
}

/** The global settings a server's unset overrides fall back to, in the units the view shows. */
export interface MCPClientGlobalSettings {
	toolSyncIntervalMinutes: number;
	maxProtocolVersion: string;
	toolExecutionTimeoutSeconds: number;
	maxInstructionsLength: number;
}

// stateDescription is the sentence under the sheet title. The pending and
// needs_reauth prose is unchanged; unstable and degraded gain a sentence
// naming what Bifrost's last check ran into, and needs_reauth appends the
// recorded reason so the explanation sits next to the instruction.
export function stateDescription(mcpClient: MCPClient, isPerUserAuth: boolean): string {
	const failure = mcpClient.last_failure;
	if (perUserDiscoveryOn(mcpClient.config)) {
		const perUserDescription = perUserDiscoveryStateDescription(mcpClient);
		if (perUserDescription) return perUserDescription;
	}
	switch (mcpClient.state) {
		case "pending_verification":
			return mcpClient.config.auth_type === "token_exchange"
				? "This server needs a one-time verification: Bifrost exchanges your signed-in identity token, tests the connection, and discovers tools. Callers then have their own identity tokens exchanged automatically on every tool call."
				: mcpClient.config.auth_type === "per_user_oauth"
					? "This client was declared in config.json. An admin sign-in is needed to verify the OAuth setup and discover tools; Bifrost keeps it on file to refresh the tool list periodically. Each user will still authenticate individually when they use this server."
					: "This client was declared in config.json and needs a one-time OAuth authorization before it can be used.";
		case "needs_reauth": {
			// Each auth type names the repair action the actions menu actually
			// offers for it, matching the credential block below.
			const base =
				mcpClient.config.auth_type === "token_exchange"
					? "The admin credential Bifrost keeps on file to refresh this server's tool list needs repair. Callers' tool calls are unaffected. Use Re-verify as me from the server's actions menu to fix it."
					: isPerUserAuth
						? "The admin credential Bifrost keeps on file to refresh this server's tool list needs repair. End-user credentials and tool calls are unaffected. Use Refresh admin credential from the server's actions menu to fix it."
						: "This connection's credentials need to be re-authorized. Use Reauthorize from the server's actions menu to redo the OAuth consent flow.";
			return failure ? `${base} Reason: ${failure.message}` : base;
		}
		case "unstable":
			return failure
				? `Bifrost's last connection check failed ${formatDurationSince(failure.at)} ago while ${failureStageLabel(failure.stage).toLowerCase()}. Tool calls are still attempted normally; the next check runs within about 10 seconds.`
				: "Bifrost's last connection check failed. Tool calls are still attempted normally; the next check runs within about 10 seconds.";
		case "degraded":
			return "Instances of this deployment disagree about this server's state. Tool calls are still attempted on every instance.";
		default:
			return "MCP server configuration and available tools";
	}
}

// perUserDiscoveryStateDescription is the sentence for a server with
// per_user_discovery on while it is pending or healthy: its admin step only
// verifies the server, and each caller discovers tools with their own
// credential. Other states keep their general wording.
function perUserDiscoveryStateDescription(mcpClient: MCPClient): string | undefined {
	switch (mcpClient.state) {
		case "pending_verification":
			switch (mcpClient.config.auth_type) {
				case "token_exchange":
					return "This server needs a one-time verification: Bifrost exchanges your signed-in identity token and tests the connection. Nothing from it is kept: each caller's tools, prompts and resources are discovered with their own identity token.";
				case "per_user_oauth":
					return "An admin sign-in is needed once to verify the OAuth setup. Nothing from it is kept: each caller's tools, prompts and resources are discovered when they sign in.";
				default:
					return "Verify this server once with sample header values to test the connection. Nothing from it is kept: each caller's tools, prompts and resources are discovered with their own headers.";
			}
		case "healthy":
			return "Each caller's tools, prompts and resources are discovered with their own credential when they connect. This server keeps no admin credential.";
		default:
			return undefined;
	}
}

/** API sends tool_sync_interval as nanoseconds (Go time.Duration). Normalize to minutes for form/store. */
export function toolSyncIntervalToMinutes(v: number | undefined | null): number {
	if (v === undefined || v === null) return 0;
	const n = Number(v);
	if (Number.isNaN(n)) return 0;
	if (Math.abs(n) >= 1e9) return Math.round(n / 6e10);
	return n;
}

/** API sends tool_execution_timeout as a Go duration string e.g. "30s". Normalize to whole seconds for form. */
export function toolExecutionTimeoutToSeconds(v: string | number | undefined | null): number {
	if (v === undefined || v === null || v === "") return 0;
	if (typeof v === "number") return v;
	// Parse Go duration string: "30s", "1m30s", "2h", etc.
	let total = 0;
	const re = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;
	let match;
	while ((match = re.exec(v)) !== null) {
		const n = parseFloat(match[1]);
		switch (match[2]) {
			case "ns":
				total += n / 1e9;
				break;
			case "us":
			case "µs":
				total += n / 1e6;
				break;
			case "ms":
				total += n / 1e3;
				break;
			case "s":
				total += n;
				break;
			case "m":
				total += n * 60;
				break;
			case "h":
				total += n * 3600;
				break;
		}
	}
	return Math.ceil(total);
}

/**
 * connectionTarget is what a server reaches: the command line of a stdio
 * server, the API an openapi server calls, or the URL (or its env or vault
 * reference) of an http or sse server.
 */
export function connectionTarget(config: MCPClientConfig): string {
	switch (config.connection_type) {
		case "stdio":
			return `${config.stdio_config?.command ?? ""} ${(config.stdio_config?.args ?? []).join(" ")}`.trim() || "-";
		case "openapi":
			return config.openapi_config?.base_url || "base URL from the document's servers";
		default:
			return config.connection_string?.type === "env" || config.connection_string?.type === "vault"
				? config.connection_string.ref || "-"
				: config.connection_string?.value || "-";
	}
}

/**
 * toolAccess reads one tool's switches from the saved config: enabled by
 * name or by "*", and auto-executed only while enabled, the rule the edit
 * sheet and the table's counts both apply.
 */
export function toolAccess(config: Pick<MCPClientConfig, "tools_to_execute" | "tools_to_auto_execute">, toolName: string) {
	const enabled = !!config.tools_to_execute?.some((name) => name === "*" || name === toolName);
	const autoExecute = enabled && !!config.tools_to_auto_execute?.some((name) => name === "*" || name === toolName);
	return { enabled, autoExecute };
}

const PER_USER_AUTH_TYPES = new Set(["per_user_oauth", "per_user_headers", "token_exchange"]);

const onOff = (on: boolean) => (on ? "On" : "Off");
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const listRow = (key: string, label: string, items?: string[]): MCPClientDetailRow =>
	items && items.length > 0 ? { key, label, chips: items } : { key, label, value: "None" };

/**
 * settingsRows are the Configuration rows of the view sheet. A row exists only
 * where the edit sheet shows the field for this server, and an override left
 * unset shows the global value it falls back to, marked as the global default.
 */
export function settingsRows(config: MCPClientConfig, globals: MCPClientGlobalSettings): MCPClientDetailRow[] {
	const perUserDiscovery = perUserDiscoveryOn(config);
	const withDefault = (key: string, label: string, own: string | undefined, fallback: string): MCPClientDetailRow =>
		own ? { key, label, value: own } : { key, label, value: fallback, note: "global default" };
	const syncMinutes = toolSyncIntervalToMinutes(config.tool_sync_interval);
	const timeoutSeconds = toolExecutionTimeoutToSeconds(config.tool_execution_timeout);

	// Unset reads as on, as the edit form defaults it.
	const rows: MCPClientDetailRow[] = [{ key: "ping", label: "Ping health check", value: onOff(config.is_ping_available !== false) }];
	if (config.connection_type === "http" && !PER_USER_AUTH_TYPES.has(config.auth_type ?? "")) {
		rows.push({ key: "session_stickiness", label: "Persistent connection", value: onOff(config.needs_session_stickiness === true) });
	}
	if (supportsPerUserDiscovery(config.auth_type, config.connection_type)) {
		rows.push({
			key: "per_user_discovery",
			label: "Per-Caller Discovery",
			value: onOff(perUserDiscovery),
			hint: perUserDiscovery
				? "Each caller's tools, prompts and resources are discovered with their own credential."
				: "Every caller sees what the admin credential discovers.",
		});
	}
	rows.push(
		perUserDiscovery
			? {
					key: "tool_sync_interval",
					label: "Tool sync interval",
					value: "Not used",
					hint: "This server keeps no discovery of its own to sync.",
				}
			: withDefault(
					"tool_sync_interval",
					"Tool sync interval",
					syncMinutes ? `${syncMinutes} min` : undefined,
					`${globals.toolSyncIntervalMinutes} min`,
				),
	);
	if (config.connection_type !== "openapi") {
		rows.push(
			withDefault(
				"max_protocol_version",
				"Max protocol version",
				config.max_protocol_version ? mcpMaxProtocolVersionLabel(config.max_protocol_version) : undefined,
				mcpMaxProtocolVersionLabel(globals.maxProtocolVersion),
			),
		);
	}
	rows.push(
		withDefault(
			"tool_execution_timeout",
			"Tool execution timeout",
			timeoutSeconds ? `${timeoutSeconds} s` : undefined,
			`${globals.toolExecutionTimeoutSeconds} s`,
		),
		withDefault(
			"max_instructions_length",
			"Max instruction length",
			config.max_instructions_length ? `${config.max_instructions_length.toLocaleString("en-US")} bytes` : undefined,
			`${globals.maxInstructionsLength.toLocaleString("en-US")} bytes`,
		),
	);
	return rows;
}

/**
 * authRows are the Authentication rows of the view sheet. Header values and
 * credentials are never shown: headers by name, a CA certificate as set or
 * not, and anything the API redacts stays out entirely.
 */
export function authRows(config: MCPClientConfig, scopeLabel: string): MCPClientDetailRow[] {
	const rows: MCPClientDetailRow[] = [
		{ key: "auth_type", label: "Auth type", value: `${authTypeLabel(config.auth_type)} · ${scopeLabel}` },
		listRow("headers", "Headers", Object.keys(config.headers ?? {})),
	];
	if (config.auth_type === "per_user_headers") {
		rows.push(listRow("per_user_header_keys", "Required headers", config.per_user_header_keys));
	}
	rows.push(
		config.allowed_extra_headers?.includes("*")
			? { key: "allowed_extra_headers", label: "Allowed extra headers", value: "All" }
			: listRow("allowed_extra_headers", "Allowed extra headers", config.allowed_extra_headers),
	);
	if (config.auth_type === "oauth" || config.auth_type === "per_user_oauth") {
		rows.push(
			{ key: "oauth_authorize_url", label: "Authorization URL", value: config.oauth_authorize_url || "Not set" },
			{ key: "oauth_token_url", label: "Token URL", value: config.oauth_token_url || "Not set" },
		);
		if (config.oauth_registration_url) {
			rows.push({ key: "oauth_registration_url", label: "Registration URL", value: config.oauth_registration_url });
		}
		rows.push(listRow("oauth_scopes", "Scopes", config.oauth_scopes));
		if (config.oauth_resource) {
			rows.push({ key: "oauth_resource", label: "Resource", value: config.oauth_resource });
		}
	}
	if (config.auth_type === "token_exchange") {
		const te = config.token_exchange;
		// Same rule as exchangesAsSSOApplication: id_jag always exchanges as the SSO login application.
		const asSSOApplication = !!te?.use_idp_credentials || te?.profile === "id_jag";
		rows.push(
			{ key: "token_exchange_audience", label: "Audience", value: te?.audience || "Not set" },
			{
				key: "token_exchange_application",
				label: "Exchange application",
				value: asSSOApplication ? "Identity provider application" : "Dedicated application",
			},
			{ key: "token_exchange_server", label: "Authorization server", value: te?.authorization_server_url || "SSO login issuer" },
			listRow("token_exchange_scopes", "Scopes", te?.scopes),
		);
		if (te?.profile === "id_jag") {
			rows.push({ key: "token_exchange_profile", label: "Profile", value: "Cross App Access (ID-JAG)" });
		}
	}
	if (config.connection_type === "openapi") {
		const schemes = Object.keys(config.openapi_config?.security_credentials ?? {});
		if (schemes.length > 0) {
			rows.push({ key: "openapi_credentials", label: "API credentials", chips: schemes });
		}
	}
	if (config.connection_type === "http" || config.connection_type === "sse") {
		const ca = config.tls_config?.ca_cert_pem;
		rows.push(
			{ key: "tls_verification", label: "TLS verification", value: config.tls_config?.insecure_skip_verify ? "Skipped" : "On" },
			{ key: "tls_ca", label: "Custom CA certificate", value: ca?.value?.trim() || ca?.ref?.trim() ? "Set" : "None" },
		);
	}
	return rows;
}

export type MCPClientBadgeVariant = "default" | "secondary" | "outline" | "success" | "destructive";

/** heroChips sum a server up at the top of the view: how it connects, how it signs in, and the modes that change its behaviour. */
export function heroChips(config: MCPClientConfig, scopeLabel: string): { label: string; variant: MCPClientBadgeVariant }[] {
	const authed = !!config.auth_type && config.auth_type !== "none";
	const chips: { label: string; variant: MCPClientBadgeVariant }[] = [
		{ label: connectionTypeLabel(config.connection_type), variant: "outline" },
		{ label: authed ? `${authTypeLabel(config.auth_type)} · ${scopeLabel}` : "No auth", variant: "outline" },
	];
	if (perUserDiscoveryOn(config)) chips.push({ label: "Per-Caller Discovery", variant: "default" });
	if (config.is_code_mode_client) chips.push({ label: "Code mode", variant: "secondary" });
	return chips;
}

/**
 * heroRows are the identifiers at the top of the view: the endpoint callers
 * connect to, and what the server itself reaches. copy is the text the copy
 * button puts on the clipboard, the full URL for the endpoint.
 */
export function heroRows(config: MCPClientConfig, baseUrl: string, specSummary: string): { label: string; value: string; copy?: string }[] {
	const rows: { label: string; value: string; copy?: string }[] = [];
	if (config.endpoint_slug) {
		rows.push({ label: "Endpoint", value: `/mcp/${config.endpoint_slug}`, copy: `${baseUrl}/mcp/${config.endpoint_slug}` });
	}
	const target = connectionTarget(config);
	const copyable = target === "-" ? {} : { copy: target };
	switch (config.connection_type) {
		case "openapi":
			rows.push({ label: "Spec", value: specSummary });
			rows.push({ label: "Calls", value: target, ...(config.openapi_config?.base_url ? { copy: target } : {}) });
			break;
		case "stdio":
			rows.push({ label: "Command", value: target, ...copyable });
			break;
		default:
			rows.push({ label: "URL", value: target, ...copyable });
	}
	return rows;
}

/**
 * toolStat is the Tools figure at the top of the view. Counts cover only the
 * discovered tools: nothing prunes a name from the config when the server
 * stops listing it, the same rule the servers table follows.
 */
export function toolStat(client: Pick<MCPClient, "config" | "tools" | "state">): { value: string; sub: string } {
	const tools = client.tools ?? [];
	if (perUserDiscoveryOn(client.config)) {
		return tools.length > 0
			? { value: `${tools.length} seen`, sub: "in callers' discoveries" }
			: { value: "None seen", sub: "no caller has connected yet" };
	}
	if (tools.length === 0) {
		return client.state === "pending_verification"
			? { value: "None yet", sub: "discovered after verification" }
			: { value: "None", sub: "the server lists no tools" };
	}
	const access = tools.map((t) => toolAccess(client.config, t.name));
	const enabled = access.filter((a) => a.enabled).length;
	const auto = access.filter((a) => a.autoExecute).length;
	return { value: `${enabled} of ${tools.length} enabled`, sub: auto > 0 ? `${auto} auto-execute` : "none auto-execute" };
}

/** accessStat is the Access figure at the top of the view: what reaches the server besides its own endpoint. */
export function accessStat(config: MCPClientConfig, virtualKeys: number, virtualMcps: number): { value: string; sub: string } {
	const keys = plural(virtualKeys, "virtual key", "virtual keys");
	const vmcps = plural(virtualMcps, "Virtual MCP", "Virtual MCPs");
	if (config.allow_by_default) {
		const extras = [virtualKeys > 0 ? keys : "", virtualMcps > 0 ? vmcps : ""].filter(Boolean);
		return { value: "Allowed by default", sub: extras.length > 0 ? `and ${extras.join(" · ")}` : "no key overrides" };
	}
	return {
		value: virtualKeys > 0 ? keys : "No access",
		sub: [virtualMcps > 0 ? `and ${vmcps}` : "", "not allowed by default"].filter(Boolean).join(" · "),
	};
}

/**
 * toolHints are the behaviour hints a server declares on a tool. Only hints
 * set to true are shown: the spec's defaults would otherwise mark every
 * unannotated tool destructive and open-world. destructiveHint means nothing
 * on a read-only tool, so it is dropped there.
 */
export function toolHints(annotations: MCPClientTool["annotations"]): { label: string; tone: "read" | "danger" | "plain" }[] {
	if (!annotations) return [];
	const hints: { label: string; tone: "read" | "danger" | "plain" }[] = [];
	if (annotations.readOnlyHint === true) hints.push({ label: "Read-only", tone: "read" });
	if (annotations.destructiveHint === true && annotations.readOnlyHint !== true) hints.push({ label: "Destructive", tone: "danger" });
	if (annotations.idempotentHint === true) hints.push({ label: "Idempotent", tone: "plain" });
	if (annotations.openWorldHint === true) hints.push({ label: "Open world", tone: "plain" });
	return hints;
}

function schemaTypeLabel(schema: unknown): string {
	if (!schema || typeof schema !== "object") return "any";
	const s = schema as Record<string, unknown>;
	if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum.map(String).join(" | ");
	if (Array.isArray(s.type)) return s.type.map(String).join(" | ");
	if (s.type === "array") return `${schemaTypeLabel(s.items)}[]`;
	if (typeof s.type === "string") return s.type;
	const union = s.anyOf ?? s.oneOf;
	if (Array.isArray(union)) return union.map(schemaTypeLabel).join(" | ");
	return s.properties ? "object" : "any";
}

function schemaProperties(schema: unknown): [string, Record<string, unknown>][] {
	if (!schema || typeof schema !== "object") return [];
	const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
	return Object.entries(properties).map(([name, value]) => [name, (value ?? {}) as Record<string, unknown>]);
}

/** schemaParams lists a tool's input schema as rows: name, a short type, whether it is required, and its description. */
export function schemaParams(schema: unknown): { name: string; type: string; required: boolean; description: string }[] {
	const required = new Set(((schema as { required?: string[] } | undefined)?.required ?? []).map(String));
	return schemaProperties(schema).map(([name, prop]) => ({
		name,
		type: schemaTypeLabel(prop),
		required: required.has(name),
		description: typeof prop.description === "string" ? prop.description : "",
	}));
}

/** schemaSummary is a tool's output schema on one line, its fields with their types. */
export function schemaSummary(schema: unknown): string {
	return schemaProperties(schema)
		.map(([name, prop]) => `${name}: ${schemaTypeLabel(prop)}`)
		.join(" · ");
}

export type MCPClientAlertActionKind = "authorize" | "reauthorize" | "refresh_headers" | "verify_exchange" | "reconnect";

export interface MCPClientAlert {
	variant: "default" | "destructive" | "warning" | "info";
	title: string;
	lines: string[];
	action?: { kind: MCPClientAlertActionKind; label: string };
}

// repairAction is the actions-menu item that repairs a needs_reauth server's
// credential, with the menu's own label. A server with per_user_discovery on
// keeps no credential of its own to repair.
function repairAction(config: MCPClientConfig): MCPClientAlert["action"] {
	if (perUserDiscoveryOn(config)) return undefined;
	switch (config.auth_type) {
		case "oauth":
			return { kind: "reauthorize", label: "Reauthorize" };
		case "per_user_oauth":
			return { kind: "reauthorize", label: "Refresh admin credential" };
		case "per_user_headers":
			return { kind: "refresh_headers", label: "Refresh admin credential" };
		case "token_exchange":
			return { kind: "verify_exchange", label: "Re-verify as me" };
		default:
			return undefined;
	}
}

function failureLine(failure: NonNullable<MCPClient["last_failure"]>): string {
	return `${failureStageLabel(failure.stage)}: ${failure.message}`;
}

/**
 * alertFor is the alert the view shows above everything else when a server is
 * not healthy: what is wrong, what Bifrost last saw, and at most one action,
 * the same one the actions menu offers for that state. canReconnect is
 * canReconnectMCPClient for the server.
 */
export function alertFor(client: MCPClient, canReconnect: boolean): MCPClientAlert | null {
	const failure = client.last_failure;
	const reconnect: MCPClientAlert["action"] =
		canReconnect && !client.config.disabled ? { kind: "reconnect", label: "Reconnect" } : undefined;
	const failureLines = failure ? [failureLine(failure), formatFailureTiming(failure, client.state)] : [];
	switch (client.state) {
		case "pending_verification":
			return {
				variant: "warning",
				title: "Verification required",
				lines: [stateDescription(client, PER_USER_AUTH_TYPES.has(client.config.auth_type ?? ""))],
				action: { kind: "authorize", label: "Authorize" },
			};
		case "needs_reauth":
			return {
				variant: "destructive",
				title: stateReasonTitle("needs_reauth", false),
				lines: [
					PER_USER_AUTH_TYPES.has(client.config.auth_type ?? "")
						? "The admin credential Bifrost keeps to refresh this server's tool list needs repair. Callers' own credentials and tool calls are unaffected."
						: "This connection's credentials need to be re-authorized.",
					...failureLines,
				],
				action: repairAction(client.config),
			};
		case "unstable":
			return {
				variant: "warning",
				title: stateReasonTitle("unstable", !!client.node_states),
				lines: [...failureLines, "Tool calls are still attempted normally; the next check runs within about 10 seconds."],
				action: reconnect,
			};
		case "degraded": {
			const groups = client.node_states ? foldInstanceStates(client.node_states) : [];
			return {
				variant: "info",
				title: stateReasonTitle("degraded", groups.length > 0),
				lines: [
					...groups.map((g) => {
						const head = `${plural(g.count, "instance", "instances")}: ${g.state.replace(/_/g, " ")}`;
						return g.last_failure
							? `${head}, ${failureLine(g.last_failure)}, ${formatFailureTiming(g.last_failure, g.state).toLowerCase()}.`
							: `${head}.`;
					}),
					"Tool calls are still attempted on every instance.",
				],
				action: reconnect,
			};
		}
		case "error":
			return { variant: "destructive", title: stateReasonTitle("error", false), lines: failureLines, action: reconnect };
		case "disabled":
			return {
				variant: "default",
				title: "Disabled",
				lines: [
					"Its connection, health checks and tool sync are off, and callers can't use its tools. Turn it back on with the Status switch in the servers table, or in the edit sheet.",
				],
			};
		default:
			return null;
	}
}

/** allowedToolsBadges read a tool allow-list the way the virtual key sheet shows one. */
export function allowedToolsBadges(tools: string[]): { label: string; variant: MCPClientBadgeVariant }[] {
	if (tools.includes("*")) return [{ label: "All Tools", variant: "success" }];
	if (tools.length === 0) return [{ label: "No tools (deny all)", variant: "destructive" }];
	return tools.map((tool) => ({ label: tool, variant: "secondary" }));
}

/** sessionKinds are the session rows a server's auth type stores per caller: tokens or header values, plus pending sign-ins. */
export function sessionKinds(authType: MCPClientConfig["auth_type"]): MCPSessionKind[] {
	switch (authType) {
		case "per_user_oauth":
			return ["token", "flow"];
		case "per_user_headers":
			return ["header", "flow"];
		default:
			return [];
	}
}

/** callerStatuses are the statuses a server's caller rows can have, with the labels the Auth Sessions page uses. */
export function callerStatuses(authType: MCPClientConfig["auth_type"]): { status: MCPSessionStatus; label: string }[] {
	return authType === "per_user_headers"
		? [
				{ status: "active", label: "Active" },
				{ status: "needs_update", label: "Needs update" },
				{ status: "pending", label: "Pending" },
				{ status: "orphaned", label: "Orphaned" },
			]
		: [
				{ status: "active", label: "Active" },
				{ status: "needs_reauth", label: "Needs re-auth" },
				{ status: "pending", label: "Pending sign-in" },
				{ status: "orphaned", label: "Orphaned" },
			];
}

/** callersSummary is the Callers figure at the top of the view: every stored row, and how many need the caller to act. */
export function callersSummary(counts: Partial<Record<MCPSessionStatus, number>>): { total: number; sub: string } {
	const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
	if (total === 0) return { total, sub: "no sessions yet" };
	const attention = (counts.needs_reauth ?? 0) + (counts.needs_update ?? 0) + (counts.pending ?? 0);
	const active = `${counts.active ?? 0} active`;
	return { total, sub: attention > 0 ? `${active} · ${attention} need attention` : active };
}

/** bindingLabel is who a caller row belongs to, the way the Auth Sessions page names it. */
export function bindingLabel(row: MCPSessionRow): { name: string; kind: string } {
	switch (row.auth_mode) {
		case "vk":
			return { name: row.virtual_key?.name || row.virtual_key?.id || "-", kind: "Virtual key" };
		case "session":
			return { name: row.session_id || "-", kind: "Session" };
		default:
			return { name: row.user?.name || row.user?.email || row.user_id || "-", kind: "User" };
	}
}
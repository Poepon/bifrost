// Runtime registry for a kind of access grant a downstream build adds to an
// MCP server's view sheet, beyond the virtual keys and Virtual MCPs every
// build shows. The base build registers none, so the sheet shows only those
// two. A downstream build registers one from its registrations module, which
// the view sheet imports for its side effect.

import type { ComponentType } from "react";

export interface MCPClientAccessGrantsSectionProps {
	mcpClientId: string;
	/** Whether the Access tab is showing, so the section can defer work until it is. */
	active: boolean;
}

export interface MCPClientAccessGrants {
	/**
	 * Counts the grants reaching the server, or undefined while they load.
	 * Called as a hook on every render of the view sheet.
	 */
	useCount: (mcpClientId: string) => number | undefined;
	/** The grant's name in the Access figure, e.g. "3 keys · 2 <many>". */
	noun: { one: string; many: string };
	/** Lists the grants on the Access tab, under Virtual Key Assignments. */
	Section: ComponentType<MCPClientAccessGrantsSectionProps>;
}

let accessGrants: MCPClientAccessGrants | undefined;

/**
 * Registers (or replaces) the extra access grants. Intended to be called at
 * module load, once, before the first render that reads the registry.
 */
export function registerMCPClientAccessGrants(grants: MCPClientAccessGrants): void {
	accessGrants = grants;
}

/** Returns the registered access grants, or undefined in builds without any. */
export function getMCPClientAccessGrants(): MCPClientAccessGrants | undefined {
	return accessGrants;
}

const noCount = (): number | undefined => undefined;

/**
 * useMCPClientAccessGrantCount counts the registered grants reaching the
 * server, or returns undefined when none are registered. Registration happens
 * once at module load, so the hook it calls is the same on every render.
 */
export function useMCPClientAccessGrantCount(mcpClientId: string): number | undefined {
	const useCount = accessGrants?.useCount ?? noCount;
	return useCount(mcpClientId);
}
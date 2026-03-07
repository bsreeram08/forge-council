import {
  PermissionLevel,
  BUILTIN_TOOLS,
  AGENT_TOOL_ACCESS,
  type ToolDefinition,
} from './tool-registry';

// ============================================================================
// Permission Hierarchy
// ============================================================================

const PERMISSION_ORDER = [
  PermissionLevel.READ_ONLY,
  PermissionLevel.READ_WRITE,
  PermissionLevel.ADMIN,
];

/**
 * Compare two permission levels
 * @returns negative if a < b, 0 if equal, positive if a > b
 */
function comparePermissionLevels(
  a: PermissionLevel,
  b: PermissionLevel
): number {
  const indexA = PERMISSION_ORDER.indexOf(a);
  const indexB = PERMISSION_ORDER.indexOf(b);
  return indexA - indexB;
}

/**
 * Check if agent permission level meets or exceeds required level
 */
function hasSufficientPermission(
  agentLevel: PermissionLevel,
  requiredLevel: PermissionLevel
): boolean {
  return comparePermissionLevels(agentLevel, requiredLevel) >= 0;
}

// ============================================================================
// Tool Guard Functions
// ============================================================================

export interface ToolAccessResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check if an agent can use a specific tool
 * Returns detailed result with reason for denial
 */
export function canUseTool(
  agentId: string,
  toolId: string
): ToolAccessResult {
  const access = AGENT_TOOL_ACCESS[agentId];

  // Check if agent exists in registry
  if (!access) {
    return {
      allowed: false,
      reason: `Agent '${agentId}' not found in tool access registry`,
    };
  }

  // Check if tool exists
  const tool = BUILTIN_TOOLS[toolId];
  if (!tool) {
    return {
      allowed: false,
      reason: `Tool '${toolId}' not found in builtin tools registry`,
    };
  }

  // Check denied tools list (overrides everything including wildcard)
  if (access.deniedTools?.includes(toolId)) {
    return {
      allowed: false,
      reason: `Tool '${toolId}' is explicitly denied for agent '${agentId}'`,
    };
  }

  // Check if tool is in allowed list (or wildcard)
  const hasToolAccess =
    access.tools === '*' || access.tools.includes(toolId);

  if (!hasToolAccess) {
    return {
      allowed: false,
      reason: `Tool '${toolId}' is not in the allowed tools list for agent '${agentId}'`,
    };
  }

  // Check permission level hierarchy
  const hasPermission = hasSufficientPermission(
    access.permission,
    tool.permissionRequired
  );

  if (!hasPermission) {
    return {
      allowed: false,
      reason: `Agent '${agentId}' has permission level '${access.permission}' but tool '${toolId}' requires '${tool.permissionRequired}'`,
    };
  }

  return { allowed: true };
}

/**
 * Get list of tool IDs that an agent is allowed to use
 * Filters by permission level and deniedTools list
 */
export function getAllowedTools(agentId: string): string[] {
  const access = AGENT_TOOL_ACCESS[agentId];

  if (!access) {
    return [];
  }

  // Get all tool IDs to check
  let toolIdsToCheck: string[];

  if (access.tools === '*') {
    // Wildcard - check all tools
    toolIdsToCheck = Object.keys(BUILTIN_TOOLS);
  } else {
    // Specific tool list
    toolIdsToCheck = access.tools;
  }

  // Filter by permission level and denied list
  return toolIdsToCheck.filter((toolId) => {
    // Skip denied tools
    if (access.deniedTools?.includes(toolId)) {
      return false;
    }

    const tool = BUILTIN_TOOLS[toolId];
    if (!tool) {
      return false;
    }

    // Check permission level
    return hasSufficientPermission(access.permission, tool.permissionRequired);
  });
}

/**
 * Get detailed information about why a tool was denied
 * (Convenience function for logging/debugging)
 */
export function getToolDenialReason(
  agentId: string,
  toolId: string
): string | undefined {
  const result = canUseTool(agentId, toolId);
  return result.reason;
}

/**
 * Check if agent has wildcard access to all tools
 */
export function hasWildcardAccess(agentId: string): boolean {
  const access = AGENT_TOOL_ACCESS[agentId];
  if (!access) return false;
  return access.tools === '*';
}

/**
 * Get permission level for an agent
 */
export function getAgentPermissionLevel(
  agentId: string
): PermissionLevel | undefined {
  return AGENT_TOOL_ACCESS[agentId]?.permission;
}

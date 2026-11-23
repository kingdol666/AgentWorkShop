/**
 * Default-workspace selection for channels created outside the console
 * (REST/script entry points). The console is workspace-scoped
 * (`/workshop/w/:wsId`), so an unmounted channel is invisible there even
 * though it exists. These helpers keep the selection rule pure and testable.
 */
import type { WorkspaceRow } from '../../db/database'

/** The workspace created on demand for the first unmounted channel. */
export const DEFAULT_WORKSPACE_NAME = '默认工作区'

/**
 * Prefer the owner's explicitly named default workspace; otherwise reuse the
 * owner's oldest workspace (stable ordering from the repo) instead of creating
 * another one. `null` means the caller must create the default workspace.
 */
export function chooseWorkspaceForNewChannel(workspaces: readonly WorkspaceRow[]): WorkspaceRow | null {
  if (workspaces.length === 0) return null
  return workspaces.find(workspace => workspace.name === DEFAULT_WORKSPACE_NAME) ?? workspaces[0] ?? null
}

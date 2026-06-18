import type { AdminConfig } from "@/shared/types";
import type { AppRoute, UserRole } from "@/routes/routes";
import { useAdminWorkspaceActions, type WorkspaceActions } from "./useAdminWorkspaceActions";
import { useAdminWorkspaceDerived, type WorkspaceDerived } from "./useAdminWorkspaceDerived";
import { useAdminWorkspaceState, type ModalImage, type WorkspaceState } from "./useAdminWorkspaceState";

export type UseAdminWorkspaceResult = WorkspaceState & WorkspaceDerived & WorkspaceActions & {
  activeRoute: AppRoute;
  refreshConfig: (options?: { runtime?: boolean; silent?: boolean }) => Promise<AdminConfig>;
};

export { ModalImage };

export function useAdminWorkspace(auth?: { currentUser?: string | null; role?: UserRole }): UseAdminWorkspaceResult {
  const state = useAdminWorkspaceState(auth);
  const derived = useAdminWorkspaceDerived({
    config: state.config,
    busy: state.busy,
    activeRoute: state.activeRoute,
    showEmails: state.showEmails,
    role: state.role,
  });
  const actions = useAdminWorkspaceActions(state);
  return { ...state, ...derived, ...actions };
}

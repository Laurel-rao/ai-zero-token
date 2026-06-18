import type { AdminConfig, RequestLog } from "@/shared/types";
import { RequestLogs } from "./components/RequestLogs";
import type { UserRole } from "@/routes/routes";

export function LogsPage(props: {
  logs: RequestLog[];
  config: AdminConfig | null;
  currentUser: string | null;
  role: UserRole;
  dataOwnerFilter: string;
  setDataOwnerFilter: (value: string) => void;
}) {
  return <RequestLogs {...props} />;
}

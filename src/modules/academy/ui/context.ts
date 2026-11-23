import type { AcademyPayload } from "../application/bootstrap";
import type { DialogSpec } from "./shared";
export type WorkspaceProps = {
  data: AcademyPayload;
  mutate: (path: string, body: unknown) => Promise<boolean>;
  open: (spec: DialogSpec) => void;
  detail: (title: string, content: React.ReactNode) => void;
  nav: (module: string, id?: string) => void;
  onSession: (id: string) => void;
  focusId?: string;
  busy: boolean;
  error: (message: string) => void;
  /** Reloads the academy records after an action that was sent without `mutate` (for example a batch with its own result). */
  reload?: () => Promise<void>;
};

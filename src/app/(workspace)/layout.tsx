import Studio from "@/modules/training/ui/studio";

/**
 * The staff workspace. The shell and every module live in one client component that stays mounted while the
 * person moves between module URLs (/players, /calendar, …), so navigation is instant and unsaved work is not
 * thrown away. Each page file below only supplies the URL and the page title; every request is still authorised
 * on the server.
 */
export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Studio />
      {children}
    </>
  );
}

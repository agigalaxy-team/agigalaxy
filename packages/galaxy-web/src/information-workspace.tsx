import { Search, Bell } from "lucide-react";
import { useChoiceViewLease } from "./shared/operations/choice-retained-operations";
import { useInformationSession } from "./features/information/use-information-session";
import type { InformationWorkspaceProps } from "./features/information/state";
import { InformationSearchPanel } from "./features/information/search-panel";
import { InformationWatchPanel } from "./features/information/watch-panel";
import { InformationDetailDialog } from "./features/information/detail-dialog";
import { InformationWatchComposer } from "./features/information/watch-composer";
import "./profile-settings.css";
import "./features/information/information.css";

export function InformationWorkspace(props:InformationWorkspaceProps) {
  const scope=useChoiceViewLease(props.runtime,props.subjectId);
  return <InformationSession key={scope.key+':'+props.connected+':'+(props.watchId??'')} {...props} />;
}
function InformationSession(props:InformationWorkspaceProps) {
  const model=useInformationSession(props);
  const { tab, watchOpen, setWatchOpen, preview, busy, error, notice, watchDraftPresent, showTab }=model;
  return (
    <section className="information-workspace" aria-busy={busy}>
      <header className="information-heading">
        <div>
          <h1>资料与关注</h1>
          <p>查找有用的资料，留意与你有关的变化。</p>
        </div>
      </header>
      <nav className="information-tabs" aria-label="资料与关注">
        <button
          aria-current={tab === 'search' ? 'page' : undefined}
          onClick={() => showTab('search')}
        >
          <Search size={17} />
          查找资料
        </button>
        <button
          aria-current={tab === 'watches' ? 'page' : undefined}
          onClick={() => showTab('watches')}
        >
          <Bell size={17} />
          我的关注
        </button>
      </nav>
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <output className="information-notice">
          {notice}
        </output>
      )}
      {watchDraftPresent && !watchOpen && !preview && (
        <p className="information-draft">
          <span>有一份尚未完成的关注</span>
          <button className="text-action" onClick={() => setWatchOpen(true)}>
            继续填写
          </button>
        </p>
      )}
      {tab === 'search' ? <InformationSearchPanel model={model} /> : <InformationWatchPanel model={model} />}
      <InformationDetailDialog model={model} />
      <InformationWatchComposer model={model} />
    </section>
  );
}

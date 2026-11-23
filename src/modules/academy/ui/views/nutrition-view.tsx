"use client";
import { useState } from "react";
import {
  Apple,
  Droplets,
  Activity,
  ShieldCheck,
  MessageSquare,
  CheckCircle2,
  Clock,
  LockKeyhole,
} from "lucide-react";
import type { WorkspaceProps } from "../context";
import { Tabs, Status } from "../shared";
import { publicationState, withdrawalOf } from "../../domain/withdrawal";
import {
  Pane,
  Roster,
  SearchBox,
  Blank,
  ContextNote,
  Toolbar,
  Info,
} from "../workbench";
export function NutritionView(
  p: WorkspaceProps & {
    plan: (id?: string, action?: string) => void;
    restricted: (id: string) => void;
  },
) {
  const d = p.data;
  const [query, setQuery] = useState("");
  const focused = d.nutrition.find((n) => n.id === p.focusId);
  const [playerId, setPlayerId] = useState(
    focused?.playerId ?? d.players[0]?.id ?? "",
  );
  const [planId, setPlanId] = useState(focused?.id ?? "");
  const [tab, setTab] = useState("Meal guidance");
  const rows = d.players.filter((pl) =>
    pl.name.toLowerCase().includes(query.toLowerCase()),
  );
  const player = rows.find((pl) => pl.id === playerId) ?? rows[0];
  const plans = d.nutrition.filter((n) => n.playerId === player?.id);
  const plan = plans.find((n) => n.id === planId) ?? plans[0];
  const privateRecord = d.restrictions.find((r) => r.playerId === player?.id);
  const questions = d.questions.filter((q) => q.playerId === player?.id);
  const sections = plan?.data.sections;
  return (
    <div className="reference-view">
      <Toolbar>
        <p className="muted">
          Human-authored guidance, professional review and private family
          questions.
        </p>
        {(d.permissions.coaching || d.permissions.professional) && (
          <button className="primary" onClick={() => p.plan()}>
            ＋ Create plan
          </button>
        )}
      </Toolbar>
      <div className="nutrition-workbench">
        <Pane title="Player roster">
          <SearchBox
            label="Search nutrition players"
            placeholder="Search players…"
            value={query}
            onChange={setQuery}
          />
          <Roster
            rows={rows}
            selectedId={player?.id}
            onSelect={(id) => {
              setPlayerId(id);
              setPlanId("");
            }}
            title={(pl) => pl.name}
            subtitle={(pl) =>
              d.batches.find((b) => b.id === pl.batchId)?.name ?? "Player"
            }
          />
        </Pane>
        <Pane title={`Nutrition plan${player ? ` · ${player.name}` : ""}`}>
          {player && plans.length > 1 && (
            <label>
              Plan version
              <select
                aria-label="Nutrition plan selection"
                value={plan?.id ?? ""}
                onChange={(e) => setPlanId(e.target.value)}
              >
                {plans.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.data.title} · v{n.version}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Tabs
            items={["Meal guidance", "Hydration", "Training day"]}
            value={tab}
            onChange={setTab}
          />
          {plan ? (
            <>
              <h3 className="wb-plan-title">
                {plan.data.title}
                <Status value={plan.status} />
              </h3>
              {tab === "Meal guidance" ? (
                <>
                  {[
                    ["Before training", sections?.beforeTraining, Apple],
                    ["After training", sections?.afterTraining, Apple],
                    ["Daily meals", sections?.dailyMeals, Apple],
                  ].map(([label, value, Icon]) => {
                    const SectionIcon = Icon as typeof Apple;
                    return (
                      <section
                        className="nutrition-guidance-row"
                        key={label as string}
                      >
                        <span>
                          <SectionIcon size={27} />
                        </span>
                        <h3>{label as string}</h3>
                        <p className="preserve-lines">
                          {(value as string) ||
                            "No reviewed guidance recorded in this section."}
                        </p>
                      </section>
                    );
                  })}
                  <section className="nutrition-legacy-guidance">
                    <h3>
                      {sections
                        ? "Additional / original guidance"
                        : "Existing plan guidance"}
                    </h3>
                    <p className="preserve-lines">{plan.data.guidance}</p>
                    {!sections && (
                      <ContextNote>
                        The original guidance is preserved. Structured sections
                        can be added to a draft without replacing this text.
                      </ContextNote>
                    )}
                  </section>
                </>
              ) : (
                <section className="nutrition-guidance-row single">
                  <span>
                    {tab === "Hydration" ? (
                      <Droplets size={27} />
                    ) : (
                      <Activity size={27} />
                    )}
                  </span>
                  <h3>{tab}</h3>
                  <p className="preserve-lines">
                    {tab === "Hydration"
                      ? sections?.hydration || "No hydration guidance recorded."
                      : sections?.trainingDay ||
                        "No training-day guidance recorded."}
                  </p>
                </section>
              )}
            </>
          ) : (
            <Blank
              title={player ? `No plan for ${player.name}` : "Select a player"}
              text="Create human-authored guidance and submit it to an authorised professional. No diet or clinical advice is generated."
              icon={Apple}
            />
          )}
          <div className="nutrition-preferences">
            <div>
              <Apple size={18} />
              <strong>Dietary preference</strong>
              <span>{player?.profile.preferences || "Not recorded"}</span>
            </div>
            <div>
              <LockKeyhole size={18} />
              <strong>Restricted information</strong>
              <span>
                {d.permissions.professional || d.permissions.family
                  ? "Authorised private access"
                  : "Restricted to professional / family"}
              </span>
            </div>
            {player && (d.permissions.professional || d.permissions.family) && (
              <button
                className="text-button"
                onClick={() => p.restricted(player.id)}
              >
                View / update private record →
              </button>
            )}
          </div>
          {privateRecord &&
            (d.permissions.professional || d.permissions.family) && (
              <Info
                items={[
                  {
                    label: "Reported allergies",
                    value: privateRecord.allergies,
                    icon: ShieldCheck,
                  },
                  {
                    label: "Dietary restrictions",
                    value: privateRecord.restrictions,
                    icon: ShieldCheck,
                  },
                ]}
              />
            )}
          <ContextNote>
            No automated prescriptions, supplement advice or calorie targets.
            Ordinary coaches cannot approve personalised clinical guidance.
          </ContextNote>
        </Pane>
        <div className="nutrition-review-column">
          <Pane title="Professional review">
            {plan ? (
              <>
                <div className="nutrition-review-state">
                  {["APPROVED", "SHARED"].includes(plan.status) ? (
                    <CheckCircle2 size={23} />
                  ) : (
                    <Clock size={23} />
                  )}
                  <div>
                    <Status value={plan.status} />
                    <p>
                      {plan.data.professional ?? "Professional review pending"}
                    </p>
                    <small>
                      {plan.data.approvedAt?.slice(0, 10) || "Not approved"}
                    </small>
                  </div>
                </div>
                {plan.data.reviewNote && (
                  <p className="preserve-lines">{plan.data.reviewNote}</p>
                )}
                <div className="wb-stacked-actions">
                  {!d.permissions.family && plan.status === "DRAFT" && (
                    <>
                      <button
                        className="secondary"
                        onClick={() => p.plan(plan.id, "save")}
                      >
                        Edit guidance
                      </button>
                      <button
                        className="primary"
                        onClick={() => p.plan(plan.id, "submit")}
                      >
                        Request professional review
                      </button>
                    </>
                  )}
                  {d.permissions.professional &&
                    plan.status === "IN_REVIEW" && (
                      <button
                        className="primary"
                        onClick={() => p.plan(plan.id, "approve")}
                      >
                        Approve as professional
                      </button>
                    )}
                  {(d.permissions.ops || d.permissions.professional) &&
                    plan.status === "APPROVED" && (
                      <button
                        className="primary"
                        onClick={() => p.plan(plan.id, "share")}
                      >
                        Share approved plan in portal
                      </button>
                    )}
                  {!d.permissions.family &&
                    ["APPROVED", "SHARED", "WITHDRAWN"].includes(
                      plan.status,
                    ) && (
                      <button
                        className="secondary"
                        onClick={() => p.plan(plan.id, "revise")}
                      >
                        Create draft revision
                      </button>
                    )}
                  {(d.permissions.ops || d.permissions.professional) &&
                    (plan.status === "SHARED" ||
                      publicationState(
                        d.versions.filter((v) => v.entityId === plan.id),
                        "nutrition-plan",
                      ).live) && (
                      <button
                        className="secondary danger"
                        onClick={() => p.plan(plan.id, "withdraw")}
                      >
                        Withdraw from families
                      </button>
                    )}
                </div>
                <details className="wb-revision-list">
                  <summary>Plan version history</summary>
                  {d.versions
                    .filter((v) => v.entityId === plan.id)
                    .map((v) => {
                      const w = withdrawalOf(v);
                      return (
                        <p key={v.id}>
                          v{v.version} ·{" "}
                          {w
                            ? `withdrawn from families (v${w.withdrawnVersion} · ${w.actorRole.toLowerCase().replaceAll("_", " ")}) — ${w.reason}`
                            : (v.data as { status?: string }).status}
                        </p>
                      );
                    })}
                </details>
              </>
            ) : (
              <p className="muted">
                Select a saved plan to review its approval history.
              </p>
            )}
          </Pane>
          <Pane title="Parent questions">
            {d.permissions.professional || d.permissions.family ? (
              <>
                {questions.map((q) => (
                  <div key={q.id} className="wb-question">
                    <h3>
                      <MessageSquare size={16} />
                      Private family question
                    </h3>
                    <p>{q.question}</p>
                    {q.answer ? (
                      <blockquote>{q.answer}</blockquote>
                    ) : (
                      <Status value="AWAITING_RESPONSE" />
                    )}
                    {d.permissions.professional && (
                      <QuestionReply
                        key={`${q.id}:${q.version}`}
                        {...p}
                        questionId={q.id}
                      />
                    )}
                  </div>
                ))}
                {!questions.length && (
                  <p className="muted">No private questions for this player.</p>
                )}
              </>
            ) : (
              <ContextNote>
                Parent questions are restricted to linked families and
                authorised nutrition professionals.
              </ContextNote>
            )}
          </Pane>
          <Pane title="Share approved plan">
            <p className="muted">
              Only approved guidance can be made available to linked families.
              Sharing is explicit and auditable.
            </p>
            <div className="provider-strip">
              <span>
                Portal{" "}
                <Status
                  value={plan?.status === "SHARED" ? "SHARED" : "NOT_SHARED"}
                />
              </span>
              <span>
                Email <Status value="MANUAL" />
              </span>
              <span>
                WhatsApp <Status value="MANUAL" />
              </span>
            </div>
          </Pane>
        </div>
      </div>
    </div>
  );
}
function QuestionReply(p: WorkspaceProps & { questionId: string }) {
  const q = p.data.questions.find((q) => q.id === p.questionId)!;
  const [answer, setAnswer] = useState(q.answer);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void p.mutate("/nutrition/question", {
          id: q.id,
          version: q.version,
          playerId: q.playerId,
          question: q.question,
          answer,
        });
      }}
    >
      <label>
        Private professional reply
        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          maxLength={3000}
          required
          rows={2}
        />
      </label>
      <button className="primary" disabled={p.busy}>
        Reply privately
      </button>
    </form>
  );
}

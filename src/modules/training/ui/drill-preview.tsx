"use client";
import { useState } from "react";
import {
  Target,
  Users,
  Clock,
  Package,
  ChevronLeft,
  ChevronRight,
  Plus,
} from "lucide-react";
import type { Drill } from "../domain/types";
import { Court } from "./common";
export default function DrillPreview({
  drill: d,
  onAdd,
  onPrevious,
  onNext,
  onBack,
}: {
  drill: Drill | undefined;
  onAdd: (d: Drill) => void;
  onPrevious: () => void;
  onNext: () => void;
  /** Back to the drill list (the Explore step). */
  onBack?: () => void;
}) {
  const [tab, setTab] = useState("Overview");
  return (
    <section className="drill-preview" aria-label="Selected drill preview">
      <header>
        {onBack ? (
          <button type="button" className="secondary back-to-drills" onClick={onBack}>
            <ChevronLeft size={16} />
            Back to drills
          </button>
        ) : null}
        <h2>Drill preview</h2>
        <div className="button-row">
          <button
            className="icon-button secondary"
            aria-label="Previous drill preview"
            onClick={onPrevious}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            className="icon-button secondary"
            aria-label="Next drill preview"
            onClick={onNext}
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </header>
      {d ? (
        <>
          <div className="drill-preview-title">
            <h3>{d.title}</h3>
            <span className="tag">{d.skill}</span>
          </div>
          <div className="drill-preview-columns">
          <div className="drill-preview-media">
          <Court skill={d.skill} large />
          <div className="media-unavailable">
            Illustration · Demonstration not available
          </div>
          <div className="detail-meta">
            <span className="tag">{d.level}</span>
            <span>
              <Clock size={14} />
              {d.minutes} min
            </span>
            <span>
              <Users size={14} />
              {d.players} {d.players === 1 ? "player" : "players"}
            </span>
          </div>
          </div>
          <div className="drill-preview-body">
          <div className="tabs small">
            {["Overview", "Steps", "Coaching cues", "Variations"].map((t) => (
              <button
                key={t}
                className={tab === t ? "active" : ""}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="drill-preview-instructions">
            {tab === "Overview" ? (
              <>
                <section>
                  <h4>
                    <Target size={17} />
                    Objective
                  </h4>
                  <p>{d.objective}</p>
                </section>
                <section>
                  <h4>
                    <Users size={17} />
                    Setup
                  </h4>
                  <p>{d.setup}</p>
                </section>
                <section>
                  <h4>
                    <Package size={17} />
                    Equipment
                  </h4>
                  <p>{d.equipment.join(" · ")}</p>
                </section>
                <div className="preview-variations">
                  <div>
                    <h4>Easier version</h4>
                    <p>{d.easier}</p>
                  </div>
                  <div>
                    <h4>Progression</h4>
                    <p>{d.harder}</p>
                  </div>
                </div>
                {d.safety?.length ? (
                  <section className="drill-safety">
                    <h4>Safety</h4>
                    <ul>
                      {d.safety.map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                    </ul>
                    {d.minimumAge ? (
                      <p>Suggested from age {d.minimumAge}. The coach decides for each player.</p>
                    ) : null}
                  </section>
                ) : null}
              </>
            ) : tab === "Steps" ? (
              <ol>
                {d.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            ) : tab === "Coaching cues" ? (
              <>
                <h4>Focus cues</h4>
                <ul>
                  {d.cues.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
                <h4>Common mistakes</h4>
                <ul>
                  {d.mistakes.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </>
            ) : (
              <div className="preview-variations">
                <div>
                  <h4>Easier version</h4>
                  <p>{d.easier}</p>
                </div>
                <div>
                  <h4>Progression</h4>
                  <p>{d.harder}</p>
                </div>
              </div>
            )}
          </div>
          <div className="notice">
            {d.review}. This court illustration is not a playable demonstration.
          </div>
          <button className="primary full" onClick={() => onAdd(d)}>
            <Plus size={16} />
            Add drill to session
          </button>
          </div>
          </div>
        </>
      ) : (
        <p className="muted">
          Select an authorised drill from the library to see its setup and
          coaching instructions.
        </p>
      )}
    </section>
  );
}

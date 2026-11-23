"use client";
import { useState } from "react";
import {
  Search,
  Plus,
  Star,
  Check,
  ArrowRight,
  Clock,
  Users,
  Package,
  Target,
} from "lucide-react";
import type { Drill } from "../domain/types";
import { Court, Modal } from "./common";
import { DRILL_CATEGORIES } from "../domain/catalogue";
export default function Library({
  drills,
  favourites,
  onFavourite,
  onAdd,
  onCustom,
  onPreview,
  selectedId,
}: {
  drills: Drill[];
  favourites: string[];
  onFavourite: (id: string, selected: boolean) => void;
  onAdd: (drill: Drill) => void;
  onCustom: () => void;
  onPreview?: (drill: Drill) => void;
  selectedId?: string;
}) {
  const [search, setSearch] = useState("");
  const [skill, setSkill] = useState("All skills");
  const [group, setGroup] = useState("all");
  const [level, setLevel] = useState("All levels");
  const [format, setFormat] = useState("All formats");
  const [minutes, setMinutes] = useState("Any duration");
  const [players, setPlayers] = useState("Any group");
  const [equipment, setEquipment] = useState("Any equipment");
  const [onlyFavourites, setOnlyFavourites] = useState(false);
  const [preview, setPreview] = useState<Drill | null>(null);
  const filtersActive =
    !!search ||
    onlyFavourites ||
    group !== "all" ||
    skill !== "All skills" ||
    level !== "All levels" ||
    format !== "All formats" ||
    minutes !== "Any duration" ||
    players !== "Any group" ||
    equipment !== "Any equipment";
  const clearFilters = () => {
    setSearch("");
    setOnlyFavourites(false);
    setGroup("all");
    setSkill("All skills");
    setLevel("All levels");
    setFormat("All formats");
    setMinutes("Any duration");
    setPlayers("Any group");
    setEquipment("Any equipment");
  };
  const filtered = drills.filter(
    (d) =>
      `${d.title} ${d.objective} ${d.cues.join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (group === "all" || d.category === group) &&
      (skill === "All skills" || d.skill === skill) &&
      (level === "All levels" || d.level === level) &&
      (format === "All formats" ||
        d.format === format ||
        d.format === "Both") &&
      (minutes === "Any duration" || d.minutes <= Number(minutes)) &&
      (players === "Any group" || d.players <= Number(players)) &&
      (equipment === "Any equipment" || d.equipment.includes(equipment)) &&
      (!onlyFavourites || favourites.includes(d.id)),
  );
  return (
    <section className="library">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Your coaching toolkit</span>
          <h2>Explore drills</h2>
          <p>Browse skills and build your session.</p>
        </div>
        <button className="secondary" onClick={onCustom}>
          <Plus size={16} />
          Create drill
        </button>
      </div>
      <div className="library-toolbar">
        <label className="search">
          <Search size={17} />
          <input
            aria-label="Search drills"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search drills, skills or coaching objectives…"
          />
        </label>
        <button
          className={`secondary ${onlyFavourites ? "selected" : ""}`}
          aria-pressed={onlyFavourites}
          onClick={() => setOnlyFavourites(!onlyFavourites)}
        >
          <Star size={16} />
          Favourites
        </button>
      </div>
      <div className="filter-group">
        <span className="filter-caption" aria-hidden="true">
          Group
        </span>
      <div className="skill-pills" role="group" aria-label="Drill groups">
        {[
          { id: "all", name: "All drills", count: drills.length },
          ...DRILL_CATEGORIES.map((c) => ({
            id: c.id as string,
            name: c.name,
            count: drills.filter((d) => d.category === c.id).length,
          })),
        ].map((g) => (
          <button
            key={g.id}
            className={group === g.id ? "active" : ""}
            aria-pressed={group === g.id}
            onClick={() => setGroup(g.id)}
          >
            {g.name} · {g.count}
          </button>
        ))}
      </div>
      </div>
      <div className="filter-group">
        <span className="filter-caption" aria-hidden="true">
          Skill
        </span>
      <div className="skill-pills" role="group" aria-label="Skills">
        {[
          "All skills",
          "Overhead",
          "Net play",
          "Defence",
          "Movement",
          "Serve & return",
          "Doubles",
          "Fitness",
        ].map((s) => (
          <button
            key={s}
            className={skill === s ? "active" : ""}
            aria-pressed={skill === s}
            onClick={() => setSkill(s)}
          >
            {s}
          </button>
        ))}
      </div>
      </div>
      <div className="filter-group">
        <span className="filter-caption" aria-hidden="true">
          Refine
        </span>
      <div className="filter-row">
        {[
          [
            "Level",
            level,
            setLevel,
            ["All levels", "Beginner", "Intermediate", "Advanced"],
          ],
          ["Format", format, setFormat, ["All formats", "Singles", "Doubles"]],
          ["Duration", minutes, setMinutes, ["Any duration", "10", "15", "20"]],
          ["Players", players, setPlayers, ["Any group", "2", "4", "8"]],
          [
            "Equipment",
            equipment,
            setEquipment,
            [
              "Any equipment",
              "Rackets",
              "Shuttles",
              "Net",
              "Cones",
              "Wall",
              "Resistance band",
              "Skipping rope",
              "Dumbbells",
              "Medicine ball",
            ],
          ],
        ].map(([label, value, set, options]) => (
          <label key={label as string}>
            {label as string}
            <select
              value={value as string}
              onChange={(e) => (set as (s: string) => void)(e.target.value)}
            >
              {(options as string[]).map((o) => (
                <option key={o} value={o}>
                  {["10", "15", "20"].includes(o) && label === "Duration"
                    ? `Up to ${o} min`
                    : ["2", "4", "8"].includes(o)
                      ? `Up to ${o} players`
                      : o}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      </div>
      <div className="result-heading">
        <span>{filtered.length} {filtered.length === 1 ? "drill" : "drills"} to explore</span>
        {filtersActive ? (
          <button type="button" className="text-button" onClick={clearFilters}>
            Clear filters
          </button>
        ) : (
          <span>Sample curriculum · review required</span>
        )}
      </div>
      <div className="drill-grid">
        {filtered.map((d) => (
          <article
            key={d.id}
            className={`drill-card ${selectedId === d.id ? "selected-drill" : ""}`}
          >
            <button
              className="art-button"
              onClick={() => (onPreview ? onPreview(d) : setPreview(d))}
            >
              <span aria-hidden="true" style={{ display: "contents" }}>
                <Court skill={d.skill} />
              </span>
              <span className="sr-only">Preview {d.title}, </span>
              <span className="art-duration">
                <Clock size={12} aria-hidden="true" />
                {d.minutes} min
              </span>
            </button>
            <button
              className={`favourite ${favourites.includes(d.id) ? "is-favourite" : ""}`}
              aria-label={`${favourites.includes(d.id) ? "Unfavourite" : "Favourite"} ${d.title}`}
              aria-pressed={favourites.includes(d.id)}
              onClick={() => onFavourite(d.id, !favourites.includes(d.id))}
            >
              <Star
                size={16}
                fill={favourites.includes(d.id) ? "currentColor" : "none"}
              />
            </button>
            <div className="drill-card-body">
              <div className="drill-meta">
                <span>{d.skill}</span>
                <span className={`level ${d.level.toLowerCase()}`}>
                  {d.level}
                </span>
              </div>
              <h3>{d.title}</h3>
              <p>{d.objective}</p>
              <div className="drill-bottom">
                <span>
                  <Users size={13} />
                  {d.players} {d.players === 1 ? "player" : "players"} · {d.format}
                </span>
                {d.academyId && <span>Private</span>}
              </div>
              <div className="card-actions">
                <button
                  className="secondary"
                  onClick={() => (onPreview ? onPreview(d) : setPreview(d))}
                >
                  View drill
                  <ArrowRight size={14} />
                </button>
                <button className="primary" onClick={() => onAdd(d)}>
                  <Plus size={15} />
                  Add
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
      {!filtered.length && (
        <div className="empty">
          <Search />
          <h3>No drills match yet</h3>
          <p>Try another skill, a shorter search, or clear your filters.</p>
          {filtersActive && (
            <button type="button" className="secondary" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>
      )}
      <div className="library-footnote">
        <Check size={16} />
        <span>
          Build the shared plan first. Add individual focus only where it helps.
        </span>
      </div>
      {preview && (
        <DrillDetails
          drill={preview}
          onClose={() => setPreview(null)}
          onAdd={() => onAdd(preview)}
        />
      )}
    </section>
  );
}
export function DrillDetails({
  drill: d,
  onClose,
  onAdd,
}: {
  drill: Drill;
  onClose: () => void;
  onAdd?: () => void;
}) {
  const [tab, setTab] = useState("Overview");
  return (
    <Modal title={d.title} onClose={onClose}>
      <div className="drill-detail">
        <Court skill={d.skill} large />
        <div className="media-unavailable">
          Illustration · Demonstration not available
        </div>
        <div className="detail-meta">
          <span className="tag">{d.skill}</span>
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
        {tab === "Overview" ? (
          <>
            <h3>
              <Target size={17} />
              Objective
            </h3>
            <p>{d.objective}</p>
            <h3>Setup</h3>
            <p>{d.setup}</p>
            <h3>
              <Package size={17} />
              Equipment
            </h3>
            <p>{d.equipment.join(" · ")}</p>
            {d.safety?.length ? (
              <section className="drill-safety">
                <h3>Safety</h3>
                <ul>
                  {d.safety.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
                {d.minimumAge ? (
                  <p>
                    Suggested from age {d.minimumAge}. The coach decides for
                    each player.
                  </p>
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
            <h3>Focus cues</h3>
            <ul>
              {d.cues.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
            <h3>Common mistakes</h3>
            <ul>
              {d.mistakes.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <h3>Easier</h3>
            <p>{d.easier}</p>
            <h3>Progression</h3>
            <p>{d.harder}</p>
          </>
        )}
        <div className="notice">
          {d.review}. Original Sportozen court schematic; no licensed
          demonstration has been attached.
        </div>
        {onAdd && (
          <button
            className="primary full"
            onClick={() => {
              onAdd();
              onClose();
            }}
          >
            <Plus size={16} />
            Add to session
          </button>
        )}
      </div>
    </Modal>
  );
}

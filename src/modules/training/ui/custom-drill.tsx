"use client";
import { useState } from "react";
import { Modal } from "./common";
export default function CustomDrill({
  close,
  save,
  busy,
}: {
  close: () => void;
  save: (body: unknown) => Promise<boolean>;
  busy: boolean;
}) {
  const [values, setValues] = useState({
    title: "",
    objective: "",
    setup: "",
    steps: "",
    cues: "",
    mistakes: "",
    easier: "",
    harder: "",
    equipment: "Rackets, Shuttles, Net",
    skill: "Overhead",
    level: "Beginner",
    format: "Both",
    minutes: 10,
    players: 2,
  });
  async function submit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const lines = (s: string) =>
      s
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean);
    if (
      await save({
        ...values,
        steps: lines(values.steps),
        cues: lines(values.cues),
        mistakes: lines(values.mistakes),
        equipment: values.equipment
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      })
    )
      close();
  }
  return (
    <Modal title="Create an academy drill" onClose={close}>
      <p className="muted">
        Private to your academy. New content is marked as draft and requires
        qualified coaching review.
      </p>
      <form onSubmit={submit}>
        <fieldset disabled={busy}>
          <label>
            Drill title
            <input
              required
              minLength={2}
              maxLength={120}
              value={values.title}
              onChange={(e) => setValues({ ...values, title: e.target.value })}
            />
          </label>
          <div className="form-grid">
            {(["skill", "level", "format"] as const).map((key) => (
              <label key={key}>
                {key}
                <select
                  value={values[key]}
                  onChange={(e) =>
                    setValues({ ...values, [key]: e.target.value })
                  }
                >
                  {(key === "skill"
                    ? [
                        "Overhead",
                        "Net play",
                        "Defence",
                        "Movement",
                        "Serve & return",
                        "Doubles",
                        "Fitness",
                      ]
                    : key === "level"
                      ? ["Beginner", "Intermediate", "Advanced"]
                      : ["Both", "Singles", "Doubles"]
                  ).map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </label>
            ))}
            <label>
              Suggested minutes
              <input
                required
                type="number"
                min="1"
                max="180"
                value={values.minutes}
                onChange={(e) =>
                  setValues({ ...values, minutes: Number(e.target.value) })
                }
              />
            </label>
            <label>
              Players
              <input
                required
                type="number"
                min="1"
                max="50"
                value={values.players}
                onChange={(e) =>
                  setValues({ ...values, players: Number(e.target.value) })
                }
              />
            </label>
          </div>
          {(
            [
              "objective",
              "setup",
              "steps",
              "cues",
              "mistakes",
              "easier",
              "harder",
            ] as const
          ).map((key) => (
            <label key={key}>
              {key === "cues"
                ? "Coaching cues"
                : key === "mistakes"
                  ? "Common mistakes"
                  : key === "easier"
                    ? "Easier variation"
                    : key === "harder"
                      ? "Harder variation"
                      : key}
              {["steps", "cues", "mistakes"].includes(key)
                ? " (one per line)"
                : ""}
              <textarea
                required={["objective", "setup", "steps"].includes(key)}
                minLength={["objective", "setup"].includes(key) ? 3 : undefined}
                maxLength={1000}
                rows={2}
                value={values[key]}
                onChange={(e) =>
                  setValues({ ...values, [key]: e.target.value })
                }
              />
            </label>
          ))}
          <label>
            Equipment (comma separated)
            <input
              value={values.equipment}
              onChange={(e) =>
                setValues({ ...values, equipment: e.target.value })
              }
            />
          </label>
          <div className="notice">
            No media uploaded. The drill will show a labelled schematic and
            “Demonstration not available”.
          </div>
          <button className="primary full" type="submit">
            {busy ? "Saving…" : "Save private drill"}
          </button>
        </fieldset>
      </form>
    </Modal>
  );
}

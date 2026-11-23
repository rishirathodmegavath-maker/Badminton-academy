"use client";
import { FeesView } from "./views/finance-view";
import { ReportsView } from "./views/report-view";
import { NutritionView } from "./views/nutrition-view";
import { MediaView } from "./views/media-view";

import type { WorkspaceProps } from "./context";
import {
  Status,
  options,
  choices,
  text,
  number,
  flag,
  list,
  money,
} from "./shared";
import { minorUnits } from "../../fees/domain/money";
const playerChoices = (p: WorkspaceProps) => options(p.data.players);
const commonPaymentFields = [
  { name: "amount", label: "Amount", required: true },
  { name: "reference", label: "Unique payment reference", required: true },
  {
    name: "method",
    label: "Method",
    kind: "select" as const,
    options: choices(["BANK", "CASH", "UPI", "OTHER"]),
  },
];
export function Fees(p: WorkspaceProps) {
  const d = p.data;

  const safe = (fn: () => Promise<boolean>) => {
    try {
      return fn();
    } catch (e) {
      p.error((e as Error).message);
      return Promise.resolve(false);
    }
  };
  function plan() {
    p.open({
      title: "Create fee plan",
      initial: { name: "", amount: "", currency: d.settings.data.currency },
      fields: [
        { name: "name", label: "Plan name", required: true },
        { name: "amount", label: "Fee amount", required: true },
        {
          name: "currency",
          label: "Currency",
          kind: "select",
          options: choices([d.settings.data.currency]),
        },
      ],
      submit: (v) =>
        safe(() =>
          p.mutate("/fees/plan", {
            name: text(v, "name"),
            amount: minorUnits(text(v, "amount")),
            currency: text(v, "currency"),
            archived: false,
          }),
        ),
    });
  }
  function invoice() {
    const id = crypto.randomUUID();
    p.open({
      title: "Issue academy invoice",
      initial: {
        playerIds: [],
        familyUserId: "",
        planId: "",
        description: "",
        subtotal: "",
        discount: "0",
        currency: d.settings.data.currency,
        dueDate: d.currentDate,
      },
      fields: [
        {
          name: "playerIds",
          label: "Invoiced players",
          kind: "multi",
          options: playerChoices(p).filter((o) => o.value),
        },
        {
          name: "familyUserId",
          label: "Family account (optional)",
          kind: "select",
          options: options(
            d.members.filter((m) => m.role === "GUARDIAN" && m.active),
            "Player account",
          ),
        },
        {
          name: "planId",
          label: "Fee plan (optional)",
          kind: "select",
          options: [
            { value: "", label: "Custom invoice" },
            ...d.feePlans
              .filter((pl) => !pl.archived && pl.currency === d.settings.data.currency)
              .map((pl) => ({
                value: pl.id,
                label: `${pl.name} · ${money(pl.amount, pl.currency)}`,
              })),
          ],
        },
        { name: "description", label: "Invoice description", required: true },
        {
          name: "subtotal",
          label: "Subtotal (ignored when a fee plan is selected)",
        },
        { name: "discount", label: "Fixed discount", required: true },
        {
          name: "currency",
          label: "Currency",
          kind: "select",
          options: choices([d.settings.data.currency]),
        },
        { name: "dueDate", label: "Due date", kind: "date", required: true },
      ],
      notice:
        "Family accounts require an authorised link to every invoiced child. These are academy fees, separate from Sportozen subscription billing.",
      button: "Issue invoice",
      submit: (v) =>
        safe(() => {
          const plan = d.feePlans.find((pl) => pl.id === text(v, "planId"));
          return p.mutate("/fees/invoice", {
            id,
            playerIds: list(v, "playerIds"),
            familyUserId: text(v, "familyUserId") || null,
            planId: plan?.id ?? null,
            description: text(v, "description"),
            subtotal: plan?.amount ?? minorUnits(text(v, "subtotal")),
            discount: minorUnits(text(v, "discount")),
            currency: plan?.currency ?? text(v, "currency"),
            dueDate: text(v, "dueDate"),
          });
        }),
    });
  }
  function payment(invoiceId: string) {
    const key = crypto.randomUUID();
    const row = d.invoices.find((i) => i.id === invoiceId)!;
    p.open({
      title: `Submit reference · ${row.data.number}`,
      initial: {
        amount: (row.balance / 100).toFixed(2),
        reference: "",
        method: "BANK",
      },
      fields: commonPaymentFields,
      notice:
        "A reference is a submission only. Staff must independently verify receipt of funds before a receipt is available.",
      button: "Submit payment reference",
      submit: (v) =>
        safe(() =>
          p.mutate("/fees/payment", {
            invoiceId,
            idempotencyKey: key,
            amount: minorUnits(text(v, "amount")),
            reference: text(v, "reference"),
            method: text(v, "method"),
          }),
        ),
    });
  }
  function verify(id: string) {
    const payment = d.payments.find((pay) => pay.id === id)!;
    p.open({
      title: "Verify payment reference",
      initial: { decision: "VERIFIED", reason: "", rejectionKind: "CORRECTABLE" },
      fields: [
        {
          name: "decision",
          label: "Verification decision",
          kind: "select",
          options: choices(["VERIFIED", "REJECTED"]),
        },
        {
          name: "rejectionKind",
          label: "If rejected",
          kind: "select",
          options: [
            { value: "CORRECTABLE", label: "Correctable: the reference may be resubmitted for this invoice" },
            { value: "INVALID", label: "Invalid: the reference stays blocked" },
          ],
        },
        {
          name: "reason",
          label: "Verification evidence / reason",
          kind: "textarea",
          required: true,
          max: 500,
        },
      ],
      notice: `Independently verify ${money(payment.data.amount, payment.data.currency)} against the actual receipt of funds. A screenshot or parent reference alone does not establish payment.`,
      submit: (v) =>
        p.mutate("/fees/verify", {
          id,
          version: payment.version,
          decision: text(v, "decision"),
          reason: text(v, "reason"),
          ...(text(v, "decision") === "REJECTED"
            ? { rejectionKind: text(v, "rejectionKind") }
            : {}),
        }),
    });
  }
  function refund(id: string) {
    const key = crypto.randomUUID();
    p.open({
      title: "Record an external refund",
      initial: { amount: "", reason: "", confirmedExternalRefund: false },
      fields: [
        { name: "amount", label: "Refund amount", required: true },
        {
          name: "reason",
          label: "Refund reason",
          kind: "textarea",
          required: true,
          max: 500,
        },
        {
          name: "confirmedExternalRefund",
          label: "I confirm this refund was processed outside Sportozen",
          kind: "check",
          required: true,
        },
      ],
      notice:
        "This records an already processed refund. No payment gateway is connected and no money is moved by this action.",
      submit: (v) =>
        safe(() =>
          p.mutate("/fees/refund", {
            paymentId: id,
            amount: minorUnits(text(v, "amount")),
            reason: text(v, "reason"),
            idempotencyKey: key,
            confirmedExternalRefund: flag(v, "confirmedExternalRefund"),
          }),
        ),
    });
  }
  function credits() {
    const key = crypto.randomUUID();
    p.open({
      title: "Adjust lesson credits",
      initial: { playerId: "", units: "1", reason: "" },
      fields: [
        {
          name: "playerId",
          label: "Player",
          kind: "select",
          options: playerChoices(p),
          required: true,
        },
        {
          name: "units",
          label: "Lessons (+ grant, - redeem)",
          kind: "number",
          min: -1000,
          max: 1000,
          required: true,
        },
        {
          name: "reason",
          label: "Reason",
          kind: "textarea",
          required: true,
          max: 500,
        },
      ],
      notice:
        "Lesson credits are a separate integer lesson ledger, not money or a refund. Balances cannot become negative.",
      submit: (v) =>
        p.mutate("/fees/credit", {
          playerId: text(v, "playerId"),
          units: number(v, "units"),
          reason: text(v, "reason"),
          idempotencyKey: key,
        }),
    });
  }
  return (
    <FeesView
      {...p}
      plan={plan}
      invoice={invoice}
      payment={payment}
      verify={verify}
      refund={refund}
      credits={credits}
    />
  );
}
export function Reports(p: WorkspaceProps) {
  const d = p.data;
  if (!d.enabled.reports)
    return (
      <div className="notice">
        Reports is disabled by academy settings or subscription access.
      </div>
    );
  function create() {
    p.open({
      title: "Create evidence-based report",
      initial: {
        playerId: "",
        periodStart: d.currentDate.slice(0, 7) + "-01",
        periodEnd: d.currentDate,
        title: "Training progress review",
      },
      fields: [
        {
          name: "playerId",
          label: "Player",
          kind: "select",
          options: playerChoices(p),
          required: true,
        },
        {
          name: "periodStart",
          label: "Period start",
          kind: "date",
          required: true,
        },
        {
          name: "periodEnd",
          label: "Period end",
          kind: "date",
          required: true,
        },
        { name: "title", label: "Report title", required: true },
      ],
      notice:
        "Drafts include actual recorded activities only with attendance evidence, plus explicitly reviewed observations. No scores or improvement claims are generated.",
      submit: (v) =>
        p.mutate("/reports/create", {
          playerId: text(v, "playerId"),
          periodStart: text(v, "periodStart"),
          periodEnd: text(v, "periodEnd"),
          title: text(v, "title"),
        }),
    });
  }
  function update(id: string, action: string) {
    const r = d.reports.find((r) => r.id === id)!;
    if (action === "withdraw") {
      // Withdrawing is not revising: it ends family access to the published report. The history stays.
      p.open({
        title: "Withdraw report from families",
        initial: { reason: "", confirm: false },
        fields: [
          {
            name: "reason",
            label: "Why is this report being withdrawn?",
            kind: "textarea",
            required: true,
            max: 500,
          },
          {
            name: "confirm",
            label:
              "I understand families will no longer be able to see or download this report.",
            kind: "check",
            required: true,
          },
        ],
        notice:
          "Withdrawing removes the published report from family access straight away, including the PDF. Staff keep the full history and the reason. To correct and re-issue it, create a revision afterwards. A revision on its own does not withdraw anything.",
        button: "Withdraw report",
        submit: (v) =>
          p.mutate("/reports/withdraw", {
            id,
            version: r.version,
            reason: text(v, "reason"),
          }),
      });
      return;
    }
    p.open({
      title: `${action === "save" ? "Edit report summary" : action === "revise" ? "Create report revision" : action + " report"}`,
      initial: { summary: r.data.summary, reason: "" },
      fields:
        action === "save"
          ? [
              {
                name: "summary",
                label: "Coach summary (explicitly reviewed, not generated)",
                kind: "textarea",
                max: 3000,
              },
            ]
          : action === "revise"
            ? [
                {
                  name: "reason",
                  label: "Revision reason",
                  kind: "textarea",
                  required: true,
                  max: 500,
                },
              ]
            : [],
      notice:
        action === "publish"
          ? "This approved report becomes available to authorised linked families. No email or WhatsApp is sent."
          : action === "revise"
            ? "The previous published revision remains available to authorised families until a new revision is approved and published. To take it away from families instead, use Withdraw."
            : "Review the recorded evidence before advancing this report.",
      button:
        action === "save"
          ? "Save summary"
          : action === "publish"
            ? "Publish approved report"
            : action === "approve"
              ? "Approve report"
              : action === "submit"
                ? "Submit for review"
                : "Create revision",
      submit: (v) =>
        p.mutate("/reports/update", {
          id,
          version: r.version,
          action,
          summary: text(v, "summary"),
          reason: text(v, "reason"),
        }),
    });
  }

  return <ReportsView {...p} create={create} update={update} />;
}
export function Nutrition(p: WorkspaceProps) {
  const d = p.data;
  if (!d.enabled.nutrition)
    return (
      <div className="notice">
        Nutrition is disabled by academy settings or subscription access.
      </div>
    );
  function plan(id?: string, action = "save") {
    const old = d.nutrition.find((n) => n.id === id);
    if (action === "withdraw" && old) {
      // Withdrawing is not revising: it ends family access to the shared plan. The history stays.
      p.open({
        title: "Withdraw nutrition plan from families",
        initial: { reason: "", confirm: false },
        fields: [
          {
            name: "reason",
            label: "Why is this plan being withdrawn?",
            kind: "textarea",
            required: true,
            max: 500,
          },
          {
            name: "confirm",
            label:
              "I understand families will no longer be able to see this plan.",
            kind: "check",
            required: true,
          },
        ],
        notice:
          "Withdrawing removes the shared plan from family access straight away. Staff keep the full history and the reason. A draft revision on its own does not withdraw anything.",
        button: "Withdraw plan",
        submit: (v) =>
          p.mutate("/nutrition/withdraw", {
            id: old.id,
            version: old.version,
            reason: text(v, "reason"),
          }),
      });
      return;
    }
    p.open({
      title: !old
        ? "Create nutrition draft"
        : action === "save"
          ? "Edit nutrition draft"
          : `${action} nutrition plan`,
      initial: {
        playerId: old?.playerId ?? "",
        title: old?.data.title ?? "",
        guidance: old?.data.guidance ?? "",
        reviewNote: "",
        beforeTraining: old?.data.sections?.beforeTraining ?? "",
        afterTraining: old?.data.sections?.afterTraining ?? "",
        dailyMeals: old?.data.sections?.dailyMeals ?? "",
        hydration: old?.data.sections?.hydration ?? "",
        trainingDay: old?.data.sections?.trainingDay ?? "",
      },
      fields:
        action === "save"
          ? [
              {
                name: "playerId",
                label: "Player",
                kind: "select",
                options: playerChoices(p),
                required: true,
              },
              { name: "title", label: "Plan title", required: true },
              {
                name: "guidance",
                label: "Human-authored guidance for professional review",
                kind: "textarea",
                required: true,
                max: 8000,
              },
              ...[
                { name: "beforeTraining", label: "Before training" },
                { name: "afterTraining", label: "After training" },
                { name: "dailyMeals", label: "Daily meals" },
                { name: "hydration", label: "Hydration" },
                { name: "trainingDay", label: "Training day" },
              ].map((f) => ({ ...f, kind: "textarea" as const, max: 2000 })),
            ]
          : action === "approve"
            ? [
                {
                  name: "reviewNote",
                  label: "Professional review note",
                  kind: "textarea",
                  required: true,
                  max: 1000,
                },
              ]
            : [],
      notice:
        action === "share"
          ? "Only professionally approved guidance is made available to linked families. No external message is sent."
          : "No automated prescriptions, supplements, calorie targets or clinical advice are generated. Only an authorised nutrition professional can approve a submitted plan.",
      button:
        action === "save"
          ? "Save draft"
          : action === "submit"
            ? "Submit for professional review"
            : action === "approve"
              ? "Approve as professional"
              : action === "share"
                ? "Share approved plan"
                : "Create draft revision",
      submit: (v) =>
        p.mutate("/nutrition/plan", {
          id: old?.id,
          version: old?.version,
          playerId: old?.playerId ?? text(v, "playerId"),
          title: text(v, "title"),
          guidance: text(v, "guidance"),
          reviewNote: text(v, "reviewNote"),
          sections: {
            beforeTraining: text(v, "beforeTraining"),
            afterTraining: text(v, "afterTraining"),
            dailyMeals: text(v, "dailyMeals"),
            hydration: text(v, "hydration"),
            trainingDay: text(v, "trainingDay"),
          },
          action,
        }),
    });
  }
  function restricted(playerId: string) {
    const old = d.restrictions.find((r) => r.playerId === playerId);
    p.open({
      title: "Restricted nutrition information",
      initial: {
        allergies: old?.allergies ?? "",
        restrictions: old?.restrictions ?? "",
      },
      fields: [
        {
          name: "allergies",
          label: "Reported allergies",
          kind: "textarea",
          max: 2000,
        },
        {
          name: "restrictions",
          label: "Reported dietary restrictions",
          kind: "textarea",
          max: 2000,
        },
      ],
      notice:
        "Restricted to authorised nutrition professionals and linked families. Ordinary coaching staff cannot read or change this record.",
      submit: (v) =>
        p.mutate("/nutrition/restrictions", {
          playerId,
          version: old?.version ?? 1,
          allergies: text(v, "allergies"),
          restrictions: text(v, "restrictions"),
        }),
    });
  }
  return <NutritionView {...p} plan={plan} restricted={restricted} />;
}
export function Media(p: WorkspaceProps) {
  const d = p.data;

  if (!d.enabled.manualVideo)
    return (
      <>
        <div className="notice">
          Manual video review is disabled by academy settings or subscription
          access.
        </div>
        <Status value="COMING_SOON" /> Automated AI Analysis
      </>
    );

  return <MediaView {...p} />;
}

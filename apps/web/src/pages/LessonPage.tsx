import { useCallback, useEffect, useState } from "react";
import { Navigate, useParams } from "react-router";
import { lessonApi, type LessonView } from "../lessonApi.ts";
import { ChaptersStep } from "./wizard/ChaptersStep.tsx";
import { GenerateStep } from "./wizard/GenerateStep.tsx";
import { OutlineStep } from "./wizard/OutlineStep.tsx";
import { SettingsStep } from "./wizard/SettingsStep.tsx";
import type { StepKey } from "./wizard/Stepper.tsx";

/** Furthest step a lesson has reached, so the stepper can link back to earlier steps. */
export function reachedStep(v: LessonView): StepKey {
  if (v.confirmedVersionId) return "slides";
  if (v.version) return "outline";
  return "settings";
}

export function LessonPage() {
  const { id = "", step = "" } = useParams();
  const [view, setView] = useState<LessonView | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setView(await lessonApi.get(id));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load, step]);

  if (error) return <div className="alert error">{error}</div>;
  if (!view || view.lesson.id !== id) return <div className="page-loading">Loading… 加载中</div>;
  const reached = reachedStep(view);
  switch (step) {
    case "chapters":
      return <ChaptersStep documentId={view.lesson.documentId} lesson={view} reached={reached} />;
    case "settings":
      return <SettingsStep key={view.lesson.updatedAt} view={view} reached={reached} />;
    case "outline":
      return <OutlineStep view={view} reached={reached} onChanged={load} />;
    case "slides":
      return <GenerateStep key={view.confirmedVersionId ?? "none"} view={view} reached={reached} />;
    default:
      return <Navigate to={`/lessons/${id}/${reached}`} replace />;
  }
}

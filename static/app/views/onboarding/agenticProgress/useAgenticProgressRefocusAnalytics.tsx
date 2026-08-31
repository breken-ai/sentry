import {useEffect, useRef} from 'react';

import {trackAnalytics} from 'sentry/utils/analytics';
import {useOrganization} from 'sentry/utils/useOrganization';

import type {AgenticProgressRun} from './types';

type AgenticProgressStage = AgenticProgressRun['stages'][number];

function getCurrentStage(stages: AgenticProgressStage[]) {
  return (
    stages.find(stage => ['active', 'waiting', 'failed'].includes(stage.status ?? '')) ??
    stages.findLast(stage => stage.status !== null) ??
    stages[0]
  );
}

export function useAgenticProgressRefocusAnalytics(run: AgenticProgressRun) {
  const organization = useOrganization();
  const blurredAtRef = useRef<number | null>(null);
  const currentStage = getCurrentStage(run.stages);

  useEffect(() => {
    function handleBlur() {
      blurredAtRef.current = Date.now();
    }

    function handleFocus() {
      const blurredAt = blurredAtRef.current;
      if (blurredAt === null) {
        return;
      }

      blurredAtRef.current = null;
      trackAnalytics('onboarding.agentic_progress_refocused', {
        organization,
        duration_seconds: (Date.now() - blurredAt) / 1_000,
        run_id: run.runId,
        run_status: run.runStatus,
        stage: currentStage?.stage ?? null,
        stage_status: currentStage?.status ?? null,
      });
    }

    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);

    return () => {
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
    };
  }, [currentStage?.stage, currentStage?.status, organization, run.runId, run.runStatus]);
}

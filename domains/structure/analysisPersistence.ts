import { ProjectFile, AnalysisExportPayload, SemanticLayer } from '../../types';

/**
 * Build export payload capturing analysis state (split/merge and configs).
 * Includes data needed to resume from post-merge steps without rerunning split/merge.
 */
export const buildAnalysisExportPayload = (project: ProjectFile): AnalysisExportPayload => {
  const step =
    project.mergedViewData || project.data.layers.includes('MERGE_LABEL_H') || project.data.layers.includes('MERGE_LABEL_V')
      ? 'merge'
      : project.splitRegions
        ? 'split'
        : 'raw';

  return {
    name: project.name,
    createdAt: new Date().toISOString(),
    layerConfig: project.layerConfig,
    splitRegions: project.splitRegions,
    mergedViewData: project.mergedViewData,
    data: project.data,
    activeLayers: Array.from(project.activeLayers),
    filledLayers: Array.from(project.filledLayers),
    step
  };
};

export const exportAnalysisState = (project: ProjectFile) => {
  const payload = buildAnalysisExportPayload(project);
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${project.name.replace('.dxf', '')}_analysis.json`;
  a.click();
  URL.revokeObjectURL(url);
};

const ensureLayerColors = (
  payload: AnalysisExportPayload,
  setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
  const colors: Record<string, string> = {};
  if (payload.data.layers.includes('VIEWPORT_CALC')) colors['VIEWPORT_CALC'] = '#FF00FF';
  if (payload.data.layers.includes('VIEWPORT_DEBUG')) colors['VIEWPORT_DEBUG'] = '#444444';
  if (payload.data.layers.includes('MERGE_LABEL_H')) colors['MERGE_LABEL_H'] = '#00FFFF';
  if (payload.data.layers.includes('MERGE_LABEL_V')) colors['MERGE_LABEL_V'] = '#FF00FF';
  if (Object.keys(colors).length > 0) {
    setLayerColors(prev => ({ ...prev, ...colors }));
  }
};

export const importAnalysisState = (
  file: File,
  activeProject: ProjectFile,
  setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
  setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const json = e.target?.result as string;
      if (!json) return;
      const payload = JSON.parse(json) as AnalysisExportPayload;
      if (!payload || !payload.data) {
        alert('Invalid analysis export file.');
        return;
      }

      ensureLayerColors(payload, setLayerColors);

      setProjects(prev =>
        prev.map(p => {
          if (p.id !== activeProject.id) return p;
          const newActive = new Set(payload.activeLayers || []);
          payload.filledLayers?.forEach(l => newActive.add(l));
          const mergedViewData = payload.mergedViewData || p.mergedViewData;
          const splitRegions = payload.splitRegions || p.splitRegions;
          return {
            ...p,
            data: payload.data,
            layerConfig: payload.layerConfig || p.layerConfig,
            splitRegions,
            mergedViewData,
            activeLayers: newActive.size > 0 ? newActive : p.activeLayers,
            filledLayers: new Set(payload.filledLayers || p.filledLayers)
          };
        })
      );
      alert('Analysis state imported. You can continue from the next step.');
    } catch (err) {
      console.error(err);
      alert('Failed to import analysis state.');
    }
  };
  reader.readAsText(file);
};

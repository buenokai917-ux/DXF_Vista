import React from 'react';
import { ProjectFile, EntityType, Point } from '../../types';
import { updateProject } from '../../domains/structure/common';
import { calculateBeamRawGeneration } from '../../domains/structure/beams/beamRawService';
import { calculateBeamIntersectionProcessing } from '../../domains/structure/beams/beamIntersectionService';
import { calculateBeamAttributeMounting } from '../../domains/structure/beams/beamAttributeService';
import { calculateBeamTopologyMerge } from '../../domains/structure/beams/beamTopologyService';
import { jsPDF } from 'jspdf';
import { isPointInBounds } from '../../domains/structure/common';
import { getCenter } from '../../utils/geometryUtils';

export const runBeamRawGeneration = (
  activeProject: ProjectFile,
  projects: ProjectFile[],
  setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
  setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
  const calc = calculateBeamRawGeneration(activeProject, projects);
  if (!calc) {
    console.log("No beam segments found.");
    return;
  }

  updateProject(
    activeProject,
    setProjects,
    setLayerColors,
    calc.resultLayer,
    calc.entities,
    calc.colors?.[calc.resultLayer] || '#10b981',
    calc.contextLayers,
    true
  );
  console.log(calc.message);
};

export const runBeamIntersectionProcessing = (
  activeProject: ProjectFile,
  projects: ProjectFile[],
  setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
  setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
  const calc = calculateBeamIntersectionProcessing(activeProject, projects);
  if (!calc) {
    console.log("Please run Step 1 (Raw Generation) first or no data found.");
    return;
  }

  updateProject(
    activeProject,
    setProjects,
    setLayerColors,
    calc.resultLayer,
    calc.entities,
    calc.colors[calc.resultLayer],
    calc.contextLayers,
    true,
    undefined,
    calc.layersToHide,
    () => ({ beamStep2GeoInfos: calc.geoInfos })
  );

  // Append intersection layer
  setLayerColors(prev => ({ ...prev, [calc.interLayer]: calc.colors[calc.interLayer] }));
  setProjects(prev => prev.map(p => {
    if (p.id !== activeProject.id) return p;
    const newEntities = calc.interEntities;
    const updatedData = {
      ...p.data,
      entities: [...p.data.entities, ...newEntities],
      layers: p.data.layers.includes(calc.interLayer) ? p.data.layers : [calc.interLayer, ...p.data.layers]
    };
    const newActive = new Set(p.activeLayers);
    newActive.add(calc.interLayer);
    calc.contextLayers.forEach(l => {
      if (updatedData.layers.includes(l)) newActive.add(l);
    });
    return {
      ...p,
      data: updatedData,
      activeLayers: newActive,
      beamStep2InterInfos: calc.interInfos
    };
  }));

  console.log(calc.message);
};

export const runBeamAttributeMounting = (
  activeProject: ProjectFile,
  projects: ProjectFile[],
  setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
  setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
  const calc = calculateBeamAttributeMounting(activeProject, projects);
  if (!calc) {
    console.log("No beams found in Step 2. Run Intersection Processing first.");
    return;
  }

  updateProject(
    activeProject,
    setProjects,
    setLayerColors,
    calc.resultLayer,
    calc.entities,
    calc.colors[calc.resultLayer],
    calc.contextLayers,
    true,
    undefined,
    undefined,
    () => ({ beamStep3AttrInfos: calc.infos })
  );

  setLayerColors(prev => ({ ...prev, [calc.debugLayer]: calc.colors[calc.debugLayer] }));

  console.log(calc.message);
};

export const runBeamTopologyMerge = (
  activeProject: ProjectFile,
  projects: ProjectFile[],
  setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
  setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
  const calc = calculateBeamTopologyMerge(activeProject, projects);
  if (!calc) {
    console.log("No attributes found from Step 3. Run Mount Attributes first.");
    return;
  }

  updateProject(
    activeProject,
    setProjects,
    setLayerColors,
    calc.resultLayer,
    calc.entities,
    calc.colors[calc.resultLayer],
    calc.contextLayers,
    true,
    undefined,
    calc.layersToHide,
    () => ({ beamStep4TopologyInfos: calc.infos })
  );

  // Handle error layer coloring/activation if present
  if (calc.extraLayers && calc.extraLayers.length > 0) {
    calc.extraLayers.forEach(extra => {
      setLayerColors(prev => ({ ...prev, [extra.layer]: calc.colors[extra.layer] || '#ef4444' }));
      setProjects(prev => prev.map(p => {
        if (p.id !== activeProject.id) return p;
        const layers = p.data.layers.includes(extra.layer) ? p.data.layers : [extra.layer, ...p.data.layers];
        const active = new Set(p.activeLayers);
        active.add(extra.layer);
        return {
          ...p,
          data: { ...p.data, layers, entities: [...p.data.entities, ...extra.entities] },
          activeLayers: active
        };
      }));
    });
  }

  console.log(calc.message);
};

export const runBeamCalculation = (
  activeProject: ProjectFile,
  projects: ProjectFile[],
) => {
  const infos = activeProject.beamStep4TopologyInfos;
  if (!infos || infos.length === 0) {
    console.log("No topology data from Step 4. Run Topology Merge first.");
    return;
  }

  const views = activeProject.splitRegions || [];

  type BeamStat = {
    id: string;
    parentId: string;
    code: string;
    width: number;
    height: number;
    length: number;
    volume: number;
  };

  const grouped: Record<string, BeamStat[]> = {};
  const viewVolumes: Record<string, number> = {};
  let totalProjectVolume = 0;

  infos.forEach(info => {
    if (info.volume > 0) {
      let viewName = "Uncategorized";
      let center: Point | null = info.center || null;
      if (!center && info.vertices && info.vertices.length > 0) {
        center = getCenter({ type: EntityType.LWPOLYLINE, vertices: info.vertices, layer: 'temp' });
      }

      if (center) {
        const foundRegion = views.find(v => isPointInBounds(center!, v.bounds));
        if (foundRegion) {
          if (foundRegion.info) {
            viewName = `Region ${foundRegion.info.index}`;
          } else {
            viewName = `Region ${views.indexOf(foundRegion) + 1}`;
          }
        }
      }

      if (!grouped[viewName]) {
        grouped[viewName] = [];
        viewVolumes[viewName] = 0;
      }

      const iLen = Math.round(info.length);
      const iW = Math.round(info.width);
      const iH = Math.round(info.height);
      const iVol = iLen * iW * iH;

      grouped[viewName].push({
        id: info.beamIndex.toString(),
        parentId: info.parentBeamIndex.toString(),
        code: info.code,
        width: iW,
        height: iH,
        length: iLen,
        volume: iVol
      });

      viewVolumes[viewName] += iVol;
      totalProjectVolume += iVol;
    }
  });

  const doc = new jsPDF();
  doc.setFontSize(16);
  doc.text("Structural Beam Quantity Survey", 14, 20);

  doc.setFontSize(12);
  const volM3 = (totalProjectVolume / 1e9).toFixed(3);
  doc.text(`Total Project Volume: ${volM3} m3`, 14, 30);

  let y = 40;
  const sortedViewNames = Object.keys(grouped).sort();

  sortedViewNames.forEach(viewName => {
    const stats = grouped[viewName].sort((a, b) => {
      const cA = a.code || "";
      const cB = b.code || "";
      const codeDiff = cA.localeCompare(cB, undefined, { numeric: true, sensitivity: 'base' });
      if (codeDiff !== 0) return codeDiff;
      return parseInt(a.id, 10) - parseInt(b.id, 10);
    });

    const vVol = viewVolumes[viewName];

    if (y > 260) {
      doc.addPage();
      y = 20;
    }

    doc.setFontSize(12);
    doc.setFont(undefined, 'bold');
    doc.text(`${viewName} - Vol: ${(vVol / 1e9).toFixed(3)} m3`, 14, y);
    y += 8;

    doc.setFontSize(9);
    doc.setFont(undefined, 'normal');
    doc.text("ID", 14, y);
    doc.text("Code", 30, y);
    doc.text("Len (mm)", 75, y);
    doc.text("W (mm)", 95, y);
    doc.text("H (mm)", 115, y);
    doc.text("Vol (mm3)", 135, y);
    doc.line(14, y + 2, 190, y + 2);
    y += 8;

    stats.forEach((item) => {
      if (y > 275) {
        doc.addPage();
        y = 20;
        doc.setFontSize(9);
        doc.text("ID", 14, y);
        doc.text("Code", 30, y);
        doc.text("Len (mm)", 75, y);
        doc.text("W (mm)", 95, y);
        doc.text("H (mm)", 115, y);
        doc.text("Vol (mm3)", 135, y);
        doc.line(14, y + 2, 190, y + 2);
        y += 8;
      }

      doc.text(item.id, 14, y);
      doc.text(item.code, 30, y);
      doc.text(item.length.toString(), 75, y);
      doc.text(item.width.toString(), 95, y);
      doc.text(item.height.toString(), 115, y);
      doc.text(item.volume.toLocaleString(), 135, y);

      y += 5;
    });

    y += 10;
  });

  doc.save(`Beam_Calculation_Report.pdf`);
  console.log(`Calculation Complete. Total Volume: ${volM3} m3`);
};

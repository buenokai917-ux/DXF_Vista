
import React from 'react';
import { jsPDF } from 'jspdf';
import { ProjectFile, Point, EntityType } from '../../../types';
import { isPointInBounds } from '../common';
import { getCenter } from '../../../utils/geometryUtils';

interface BeamStat {
    id: string;
    parentId: string;
    code: string;
    width: number;
    height: number;
    length: number;
    volume: number;
}

export const runBeamCalculation = (
    activeProject: ProjectFile,
    projects: ProjectFile[],
    setProjects: React.Dispatch<React.SetStateAction<ProjectFile[]>>,
    setLayerColors: React.Dispatch<React.SetStateAction<Record<string, string>>>
) => {
    // 1. Data Preparation - Use Step 4 Results
    const infos = activeProject.beamStep4TopologyInfos;

    if (!infos || infos.length === 0) {
        alert("Missing Step 4 topology data. Please run Step 4 first.");
        return;
    }

    // 2. Identify Views and Group Beams
    const views = activeProject.splitRegions || [];

    const grouped: Record<string, BeamStat[]> = {};
    const viewVolumes: Record<string, number> = {};
    let totalProjectVolume = 0;

    infos.forEach(info => {
        if (info.volume > 0) {
            // Find View Name
            let viewName = "Uncategorized";
            
            // Find center for hit testing against regions
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

    // 3. Generate PDF
    const doc = new jsPDF();
    
    // Header
    doc.setFontSize(16);
    doc.text("Structural Beam Quantity Survey", 14, 20); 
    
    doc.setFontSize(12);
    // Convert mm^3 to m^3 for summary display
    const volM3 = (totalProjectVolume / 1e9).toFixed(3);
    doc.text(`Total Project Volume: ${volM3} m3`, 14, 30);

    let y = 40;
    
    // Sort views by name to keep order
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
        doc.text(`${viewName} - Vol: ${(vVol/1e9).toFixed(3)} m3`, 14, y);
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

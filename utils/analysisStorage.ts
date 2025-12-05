
import { ProjectFile, ViewportRegion, BeamStep2GeoInfo, BeamIntersectionInfo, BeamStep3AttrInfo, BeamStep4TopologyInfo, MergedViewData } from '../types';

const STORAGE_KEY = 'DXF_VISTA_ANALYSIS_DATA';

export interface AnalysisData {
    splitRegions?: ViewportRegion[] | null;
    mergedViewData?: MergedViewData;
    beamStep2GeoInfos?: BeamStep2GeoInfo[];
    beamStep2InterInfos?: BeamIntersectionInfo[];
    beamStep3AttrInfos?: BeamStep3AttrInfo[];
    beamStep4TopologyInfos?: BeamStep4TopologyInfo[];
    timestamp: number;
}

export type GlobalAnalysisStorage = Record<string, AnalysisData>; // Keyed by fileName

export const getStoredAnalysis = (fileName: string): AnalysisData | null => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const data: GlobalAnalysisStorage = JSON.parse(raw);
        return data[fileName] || null;
    } catch (e) {
        console.error("Failed to load analysis data", e);
        return null;
    }
};

export const saveStoredAnalysis = (fileName: string, partialData: Partial<AnalysisData>) => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const globalData: GlobalAnalysisStorage = raw ? JSON.parse(raw) : {};
        
        const currentFile = globalData[fileName] || { timestamp: Date.now() };
        
        globalData[fileName] = {
            ...currentFile,
            ...partialData,
            timestamp: Date.now()
        };
        
        localStorage.setItem(STORAGE_KEY, JSON.stringify(globalData));
    } catch (e) {
        console.error("Failed to save analysis data", e);
    }
};

export const clearStoredAnalysis = (fileName: string) => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const globalData: GlobalAnalysisStorage = JSON.parse(raw);
        delete globalData[fileName];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(globalData));
    } catch (e) {
        console.error("Failed to clear analysis data", e);
    }
};

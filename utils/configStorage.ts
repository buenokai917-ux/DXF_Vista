import { SemanticLayer } from '../types';

const STORAGE_KEY = 'DXF_VISTA_LAYER_CONFIGS';

export type LayerConfigMap = Record<SemanticLayer, string[]>;
export type GlobalConfig = Record<string, LayerConfigMap>; // FileName -> Config

export const getStoredConfig = (fileName: string): LayerConfigMap | null => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const data: GlobalConfig = JSON.parse(raw);
        return data[fileName] || null;
    } catch (e) {
        console.error("Failed to load config", e);
        return null;
    }
};

export const saveStoredConfig = (fileName: string, config: LayerConfigMap) => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const data: GlobalConfig = raw ? JSON.parse(raw) : {};
        
        data[fileName] = config;
        
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
        console.error("Failed to save config", e);
    }
};

export const exportConfigsToJson = () => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            alert("No configurations to save.");
            return;
        }
        const blob = new Blob([raw], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `dxf_vista_configs_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
    } catch (e) {
        console.error("Failed to export configs", e);
    }
};

export const importConfigsFromJson = (file: File, onComplete: (config: GlobalConfig) => void) => {
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const json = e.target?.result as string;
            if (!json) return;
            
            const newData = JSON.parse(json);
            const currentRaw = localStorage.getItem(STORAGE_KEY);
            const currentData = currentRaw ? JSON.parse(currentRaw) : {};
            
            // Merge: New imported data overwrites existing for same filenames, keeps others
            const merged = { ...currentData, ...newData };
            
            localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
            alert("Configuration imported successfully.");
            onComplete(merged);
        } catch (err) {
            alert("Failed to parse configuration file.");
            console.error(err);
        }
    };
    reader.readAsText(file);
};
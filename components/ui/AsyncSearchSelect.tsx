"use client";

import React, { forwardRef } from "react";
import AsyncSelect from "react-select/async";
import { accurateFetch } from "@/lib/apiFetcher";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface SelectOption {
    label: string;
    value: string;
    originalData?: any;
}

interface AsyncSearchSelectProps {
    label?: string;
    error?: string;
    helperText?: string;
    endpoint: string;
    searchField?: string;
    labelField?: string | ((item: any) => string);
    valueField?: string;
    extraFields?: string;
    required?: boolean;
    placeholder?: string;
    value?: SelectOption | null;
    onChange?: (option: SelectOption | null) => void;
    onBlur?: () => void;
    className?: string;
}

export const AsyncSearchSelect = forwardRef<any, AsyncSearchSelectProps>(
    ({ 
        label, error, helperText, endpoint, searchField = "name", 
        labelField = "name", valueField = "no", extraFields = "",
        required, placeholder = "Ketik untuk mencari...",
        value, onChange, onBlur, className
    }, ref) => {

        const loadOptions = async (inputValue: string): Promise<SelectOption[]> => {
            if (!inputValue) return [];
            try {
                const fields = [valueField];
                if (typeof labelField === 'string') fields.push(labelField);
                if (searchField !== valueField && searchField !== labelField) fields.push(searchField);
                if (extraFields) fields.push(...extraFields.split(','));

                const payload: any = {
                    fields: Array.from(new Set(fields)).join(',')
                };

                if (inputValue) {
                    payload.keywords = inputValue;
                }

                const response = await accurateFetch(endpoint, "GET", payload);
                if (response && response.d) {
                    let results = response.d;
                    
                    // Local Strict Filtering: Accurate's global 'keywords' search is too aggressive 
                    // (finds matches in hidden addresses, contacts, etc). We force a strict UI filter here.
                    if (inputValue) {
                        const searchLower = inputValue.toLowerCase();
                        results = results.filter((item: any) => {
                            const resolvedLabel = typeof labelField === 'function' ? labelField(item) : item[labelField];
                            return (
                                String(resolvedLabel || "").toLowerCase().includes(searchLower) ||
                                String(item[valueField] || "").toLowerCase().includes(searchLower) ||
                                String(item.name || "").toLowerCase().includes(searchLower) ||
                                String(item.no || "").toLowerCase().includes(searchLower)
                            );
                        });
                    }

                    return results.map((item: any) => ({
                        label: typeof labelField === 'function' ? labelField(item) : item[labelField],
                        value: item[valueField],
                        originalData: item
                    }));
                }
                return [];
            } catch (err) {
                console.error(`Failed to fetch from ${endpoint}:`, err);
                return [];
            }
        };

        const customStyles = {
            control: (provided: any, state: any) => ({
                ...provided,
                backgroundColor: 'rgba(0, 0, 0, 0.2)',
                borderColor: error ? 'rgba(239, 68, 68, 0.5)' : state.isFocused ? 'rgba(99, 102, 241, 0.5)' : 'rgba(255, 255, 255, 0.1)',
                color: 'white',
                boxShadow: state.isFocused ? (error ? '0 0 0 2px rgba(239, 68, 68, 0.5)' : '0 0 0 2px rgba(99, 102, 241, 0.5)') : 'none',
                '&:hover': {
                    borderColor: error ? 'rgba(239, 68, 68, 0.5)' : 'rgba(255, 255, 255, 0.2)',
                },
                minHeight: '40px',
                borderRadius: '0.375rem',
            }),
            menu: (provided: any) => ({
                ...provided,
                backgroundColor: '#1a1c23',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.5), 0 4px 6px -2px rgba(0, 0, 0, 0.3)',
                zIndex: 50,
            }),
            option: (provided: any, state: any) => ({
                ...provided,
                backgroundColor: state.isSelected ? 'rgba(99, 102, 241, 0.2)' : state.isFocused ? 'rgba(255, 255, 255, 0.05)' : 'transparent',
                color: state.isSelected ? '#818cf8' : '#e2e8f0',
                cursor: 'pointer',
                '&:active': {
                    backgroundColor: 'rgba(99, 102, 241, 0.3)',
                },
            }),
            singleValue: (provided: any) => ({
                ...provided,
                color: '#f8fafc',
            }),
            input: (provided: any) => ({
                ...provided,
                color: '#f8fafc',
            }),
            placeholder: (provided: any) => ({
                ...provided,
                color: '#64748b',
                fontSize: '0.875rem',
            }),
            indicatorSeparator: () => ({
                display: 'none',
            }),
        };

        return (
            <div className={cn("flex flex-col gap-1.5 w-full", className)}>
                {label && (
                    <label className="text-sm font-medium text-slate-300">
                        {label} {required && <span className="text-red-400">*</span>}
                    </label>
                )}
                
                <AsyncSelect
                    ref={ref}
                    cacheOptions
                    defaultOptions
                    loadOptions={loadOptions}
                    value={value}
                    onChange={(newValue) => {
                        onChange && onChange(newValue as SelectOption);
                    }}
                    onBlur={onBlur}
                    placeholder={placeholder}
                    styles={customStyles}
                    noOptionsMessage={() => "Tidak ada data ditemukan"}
                    loadingMessage={() => "Mencari data..."}
                />

                {error && (
                    <span className="text-xs text-red-400 font-medium animate-in fade-in slide-in-from-top-1">
                        {error}
                    </span>
                )}
                {helperText && !error && (
                    <span className="text-xs text-slate-500">
                        {helperText}
                    </span>
                )}
            </div>
        );
    }
);

AsyncSearchSelect.displayName = "AsyncSearchSelect";

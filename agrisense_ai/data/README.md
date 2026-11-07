# AgriSense Unified Knowledge Base

Compiled on: 2026-11-05
Directory: `Backend/agrisense_ai/data`

## Overview
This directory contains the authoritative agricultural knowledge base for AgriSense, merged from:
1. `raw/rag_chunks.jsonl`, `raw/diseases.csv`, `raw/treatments.csv`, `raw/sources.csv` (BRRI / BARI / NATP-II Ministry of Agriculture)
2. `raw/agrisense-bangladesh-disease-protocols.json` (DAE / BAMIS / AIS official portal advisories)

## Files
- `agrisense_knowledge_base.json`: Hierarchical catalog of all 48 crop disease entities with verified cultural, biological, and chemical measures.
- `agrisense_knowledge_chunks.jsonl`: 48 pre-formatted, grounded chunks ready for vector embedding via Gemini (`text-embedding-004`) or pgvector.
- `raw/`: Untouched, original dataset files for provenance and auditability.

## Crops Covered
Rice (ধান), Wheat (গম), Potato (আলু), Tomato (টমেটো), Maize (ভুট্টা), Jute (পাট), Lentil (মসুর), Mustard (সরিষা), Chilli (মরিচ), Brinjal (বেগুন), Cucurbits (কুমড়া জাতীয় সবজি), Mango (আম).

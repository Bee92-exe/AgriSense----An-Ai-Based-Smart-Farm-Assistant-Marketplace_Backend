import os
import json
import csv
import re

DATA_DIR = os.path.dirname(os.path.abspath(__file__))
RAW_DIR = os.path.join(DATA_DIR, "raw")

def load_raw_files():
    # 1. Load Sources
    sources = {}
    sources_csv = os.path.join(RAW_DIR, "sources.csv")
    if os.path.exists(sources_csv):
        with open(sources_csv, "r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for r in reader:
                sources[r["source_id"].strip()] = r

    # 2. Load Diseases
    diseases = {}
    diseases_csv = os.path.join(RAW_DIR, "diseases.csv")
    if os.path.exists(diseases_csv):
        with open(diseases_csv, "r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for r in reader:
                d_id = r["disease_id"].strip()
                diseases[d_id] = {
                    "disease_id": d_id,
                    "crop_en": r["crop_en"].strip(),
                    "crop_bn": r["crop_bn"].strip(),
                    "disease_en": r["disease_en"].strip(),
                    "disease_bn": r["disease_bn"].strip(),
                    "pathogen": r.get("pathogen", "").strip(),
                    "primary_source_id": r.get("primary_source_id", "").strip(),
                    "measures": []
                }

    # 3. Load Treatments from CSV
    treatments_csv = os.path.join(RAW_DIR, "treatments.csv")
    if os.path.exists(treatments_csv):
        with open(treatments_csv, "r", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for r in reader:
                d_id = r["disease_id"].strip()
                if d_id not in diseases:
                    continue
                diseases[d_id]["measures"].append({
                    "measure_type": r["measure_type"].strip(),
                    "description_en": r["measure_description"].strip(),
                    "description_bn": "",
                    "active_ingredient": r.get("active_ingredient", "").strip(),
                    "product_name": r.get("product_name", "").strip(),
                    "dose": r.get("dose", "").strip(),
                    "timing": r.get("timing_interval", "").strip(),
                    "source_id": r.get("source_id", "").strip(),
                    "source_name": sources.get(r.get("source_id", "").strip(), {}).get("citation", "DAE / NATP-II"),
                    "source_url": sources.get(r.get("source_id", "").strip(), {}).get("url", ""),
                    "flags": r.get("flags", "").strip()
                })

    # 4. Load Dataset 2 (BAMIS / AIS JSON)
    protocols_json = os.path.join(RAW_DIR, "agrisense-bangladesh-disease-protocols.json")
    if os.path.exists(protocols_json):
        with open(protocols_json, "r", encoding="utf-8") as f:
            d2 = json.load(f)
            records = d2.get("records", [])
            for rec in records:
                crop_en = rec.get("crop_en", "").strip()
                crop_bn = rec.get("crop_bn", "").strip()
                dis_en = rec.get("disease_en", "").strip()
                dis_bn = rec.get("disease_bn", "").strip()
                txt_bn = rec.get("treatment_source_text_bn", "").strip()
                txt_en = rec.get("treatment_en", "").strip()
                dose = rec.get("dose", "")
                institution = rec.get("source_institution", "DAE / BAMIS")
                source_url = rec.get("source_url", "")
                note = rec.get("record_note", "")

                # Skip entries where there's no treatment protocol
                if not txt_bn or "did not expose a treatment" in txt_en or "No treatment protocol" in txt_en:
                    continue

                # Match with existing disease or create new
                matched_id = None
                for did, dinfo in diseases.items():
                    if dinfo["crop_en"].lower() == crop_en.lower():
                        # Compare disease name
                        if (dis_en.lower() in dinfo["disease_en"].lower()) or (dinfo["disease_en"].lower() in dis_en.lower()):
                            matched_id = did
                            break
                        if dis_bn and dinfo["disease_bn"] and dis_bn in dinfo["disease_bn"]:
                            matched_id = did
                            break

                if not matched_id:
                    # Generate a clean ID
                    clean_crop = re.sub(r'[^A-Z]', '', crop_en.upper())[:3]
                    clean_dis = re.sub(r'[^A-Z]', '', dis_en.upper())[:8]
                    matched_id = f"{clean_crop}_{clean_dis}"
                    diseases[matched_id] = {
                        "disease_id": matched_id,
                        "crop_en": crop_en,
                        "crop_bn": crop_bn,
                        "disease_en": dis_en,
                        "disease_bn": dis_bn,
                        "pathogen": "",
                        "primary_source_id": "BAMIS",
                        "measures": []
                    }

                # Add Bengali name if missing
                if not diseases[matched_id]["disease_bn"] and dis_bn:
                    diseases[matched_id]["disease_bn"] = dis_bn

                # Determine measure type
                m_type = "chemical"
                if "সার" in txt_bn or "প্লাউ" in txt_bn or "জমি" in txt_bn:
                    m_type = "cultural"
                if "বীজ শোধন" in txt_bn:
                    m_type = "seed_treatment"

                diseases[matched_id]["measures"].append({
                    "measure_type": m_type,
                    "description_en": txt_en,
                    "description_bn": txt_bn,
                    "active_ingredient": "",
                    "product_name": "",
                    "dose": str(dose) if dose else "",
                    "timing": "",
                    "source_id": "BAMIS",
                    "source_name": institution,
                    "source_url": source_url,
                    "flags": note
                })

    return diseases

def build_knowledge_chunks(diseases):
    chunks = []
    chunk_index = 0

    for did, dinfo in sorted(diseases.items()):
        crop_en = dinfo["crop_en"]
        crop_bn = dinfo["crop_bn"]
        disease_en = dinfo["disease_en"]
        disease_bn = dinfo["disease_bn"] or disease_en
        pathogen = dinfo.get("pathogen", "")

        # 1. Disease overview & pathogen chunk (if measures exist)
        measures = dinfo["measures"]
        if not measures:
            continue

        # Collect distinct measure types
        cultural_texts = []
        chemical_texts = []
        biological_texts = []
        seed_texts = []

        for m in measures:
            bn_desc = m.get("description_bn", "")
            en_desc = m.get("description_en", "")
            dose = m.get("dose", "")
            prod = m.get("product_name", "")
            source = m.get("source_name", "DAE")

            line_bn = bn_desc
            if not line_bn:
                line_bn = en_desc

            extra_parts = []
            if prod:
                extra_parts.append(f"ওষুধ/পণ্য: {prod}")
            if dose and dose.lower() != "not specified in source":
                extra_parts.append(f"মাত্রা: {dose}")
            if extra_parts:
                line_bn += f" ({', '.join(extra_parts)})"

            mtype = m.get("measure_type", "management")
            if mtype == "cultural":
                cultural_texts.append(line_bn)
            elif mtype == "biological":
                biological_texts.append(line_bn)
            elif mtype == "seed_treatment":
                seed_texts.append(line_bn)
            else:
                chemical_texts.append(line_bn)

        # Build composite chunk for RAG
        overview_parts = [
            f"ফসল: {crop_bn} ({crop_en})।",
            f"রোগ: {disease_bn} ({disease_en})।",
        ]
        if pathogen:
            overview_parts.append(f"জীবাণু/প্যাথোজেন: {pathogen}।")

        treatment_sections = []
        if cultural_texts:
            treatment_sections.append("পরিচর্যা ও প্রতিরোধ ব্যবস্থা: " + "; ".join(cultural_texts) + "।")
        if seed_texts:
            treatment_sections.append("বীজ শোধন: " + "; ".join(seed_texts) + "।")
        if biological_texts:
            treatment_sections.append("জৈব দমন পদ্ধতি: " + "; ".join(biological_texts) + "।")
        if chemical_texts:
            treatment_sections.append("রাসায়নিক প্রতিকার ও অনুমোদিত স্প্রে মাত্রা (DAE/BAMIS): " + "; ".join(chemical_texts) + "।")

        full_text = " ".join(overview_parts + treatment_sections)

        chunk_id = f"CHUNK_{did}_{chunk_index:03d}"
        chunk_index += 1

        chunks.append({
            "chunk_id": chunk_id,
            "disease_id": did,
            "crop_en": crop_en,
            "crop_bn": crop_bn,
            "disease_en": disease_en,
            "disease_bn": disease_bn,
            "pathogen": pathogen,
            "text": full_text,
            "metadata": {
                "crop": crop_en.lower(),
                "crop_bn": crop_bn,
                "disease": disease_en.lower(),
                "disease_bn": disease_bn,
                "measures_count": len(measures),
                "has_chemical": bool(chemical_texts),
                "has_cultural": bool(cultural_texts),
                "has_seed": bool(seed_texts),
                "sources": list(set(m.get("source_name", "DAE") for m in measures))
            }
        })

    return chunks

def main():
    print("Loading and parsing raw datasets...")
    diseases = load_raw_files()
    print(f"Total disease entities compiled: {len(diseases)}")

    # Save Master JSON
    master_json_path = os.path.join(DATA_DIR, "agrisense_knowledge_base.json")
    with open(master_json_path, "w", encoding="utf-8") as f:
        json.dump(diseases, f, ensure_ascii=False, indent=2)
    print(f"Saved master catalog -> {master_json_path}")

    # Build and Save RAG Chunks JSONL
    chunks = build_knowledge_chunks(diseases)
    chunks_path = os.path.join(DATA_DIR, "agrisense_knowledge_chunks.jsonl")
    with open(chunks_path, "w", encoding="utf-8") as f:
        for c in chunks:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")
    print(f"Saved {len(chunks)} ready-to-embed RAG chunks -> {chunks_path}")

    # Write README
    readme_path = os.path.join(DATA_DIR, "README.md")
    with open(readme_path, "w", encoding="utf-8") as f:
        f.write(f"""# AgriSense Unified Knowledge Base

Compiled on: 2026-11-05
Directory: `Backend/agrisense_ai/data`

## Overview
This directory contains the authoritative agricultural knowledge base for AgriSense, merged from:
1. `raw/rag_chunks.jsonl`, `raw/diseases.csv`, `raw/treatments.csv`, `raw/sources.csv` (BRRI / BARI / NATP-II Ministry of Agriculture)
2. `raw/agrisense-bangladesh-disease-protocols.json` (DAE / BAMIS / AIS official portal advisories)

## Files
- `agrisense_knowledge_base.json`: Hierarchical catalog of all {len(diseases)} crop disease entities with verified cultural, biological, and chemical measures.
- `agrisense_knowledge_chunks.jsonl`: {len(chunks)} pre-formatted, grounded chunks ready for vector embedding via Gemini (`text-embedding-004`) or pgvector.
- `raw/`: Untouched, original dataset files for provenance and auditability.

## Crops Covered
Rice (ধান), Wheat (গম), Potato (আলু), Tomato (টমেটো), Maize (ভুট্টা), Jute (পাট), Lentil (মসুর), Mustard (সরিষা), Chilli (মরিচ), Brinjal (বেগুন), Cucurbits (কুমড়া জাতীয় সবজি), Mango (আম).
""")
    print("Saved documentation -> README.md")

if __name__ == "__main__":
    main()

# AgriSense Bangladesh crop-disease knowledge set (v0.1, partial)

Built 5 Nov 2026 only from text retrieved from the sources in sources.csv. Nothing is synthetic.

## Files
- diseases.csv: disease list with English and Bangla names
- treatments.csv: one row per control measure, with active ingredient, product, dose, timing, source and flags
- sources.csv: full citations, URLs and how much of each source was actually read
- rag_chunks.jsonl: one chunk per treatment row with metadata, ready for embedding

## Coverage
Covered: Rice (12 diseases), Wheat (blast), Potato (late and early blight), Tomato (4), Brinjal (3), Cucurbits (5), Mango (3).
NOT covered yet: Maize, Jute, Mustard, Lentil, Chilli, Banana. No verified text retrieved, so no rows were invented.
Also missing: potato viral diseases, Bangla names for most diseases.

## Column notes
- bn_name_status = user_supplied: Bangla name came from the project owner's brief.
- bn_name_status = unverified: Bangla name written by the assistant, NOT taken from a source. Check against the BRRI/BARI Bangla brochures before release. Empty means no Bangla name yet.
- dose = "not specified in source": the source names the product but gives no dose. Do not fill from memory.
- flags REGULATORY_CHECK: the same document (S1, Annex 1) lists banned brand registrations such as Furadan 3G. Confirm current DAE status before showing to farmers.
- S1 is from 2014. Check every chemical against the current DAE registered pesticide list.
- S1 recommends several products (dimethoate, Metasystox) without checking their present status.

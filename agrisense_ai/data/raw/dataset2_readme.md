# AgriSense Bangladesh crop disease starter dataset

Files:

- `agrisense-bangladesh-disease-protocols.json` — source-linked records, crop coverage status, and source registry.

## Scope

The records are transcribed from Bangladesh DAE/BAMIS and AIS sources. This starter dataset has protocol rows for rice, potato, maize, jute, lentil, and mustard, plus disease-label-only rows for tomato. The coverage manifest includes all 13 requested crop groups (counting cucurbits as one group). It is **not yet a complete, verified disease-and-treatment dataset for every requested crop**: some official crop pages list diseases without accessible treatment details, some BAMIS records have malformed/missing dosage text, and chilli/pepper needs manual source review.

No missing dose, treatment, disease name, or entry was invented. Unresolved information is labelled as a gap. English names are concise translations of source labels, not a claim that every translation has been formally standardized by a Bangladesh authority.

## Important source limits

- BAMIS is an official DAE source, but the pages may contain incomplete or inconsistent entries. The current crop page should be reviewed before relying on any recommendation.
- The DAE pesticide-registration PDF is for registrations approved up to its 81st PTAC meeting and is dated 2021. It is not a current-status guarantee.
- Verify any chemical recommendation against current DAE registration and the exact product label, including formulation, crop, target, dose, pre-harvest interval, and personal protective equipment.
- Disease recognition labels and treatment evidence are separate. Image datasets do not substantiate treatment recommendations.

## Principal source links

- DAE/BAMIS disease index: https://www.bamis.gov.bd/en/diseases/
- DAE plant-protection wing topic index: https://dae.gov.bd/pages/static-pages/6922e120933eb65569e2a633
- DAE pesticide table (81st PTAC meeting): https://dae.gov.bd/sites/default/files/files/dae.portal.gov.bd/page/8a812db0_3544_4105_b066_df78074d3efb/2021-09-23-04-04-b1c554f8cfac4f27fab709ca813a61af.pdf
- BRRI Rice Knowledge Bank: https://knowledgebank-brri.org/
- BRRI disease leaflets: https://riceprofile.brri.gov.bd/cultivation/disease
- AIS potato late-blight article: https://ais.gov.bd/pages/static-pages/6922dfea933eb65569e24a16
- FAO/WHO pesticide management code (general safety reference, not Bangladesh dose authority): https://www.fao.org/fileadmin/templates/agphome/documents/Pests_Pesticides/Code/CODE_2014Sep_ENG.pdf

import { searchKnowledge } from '../services/rag/retrieval';

async function main(): Promise<void> {
  const cases = [
    { label: 'blast filter + brown-spot query', diseaseId: 'RICE_BLAST', query: 'brown spot circular lesions' },
    { label: 'brown-spot filter + blast query', diseaseId: 'RICE_BS', query: 'blast spindle lesions' },
    { label: 'unsupported disease id', diseaseId: 'NOT_A_REAL_DISEASE', query: 'anything' },
  ];

  for (const item of cases) {
    const matches = await searchKnowledge(item.query, {
      crop: 'Rice',
      diseaseId: item.diseaseId,
      threshold: 0,
      limit: 2,
    });
    console.log(
      item.label,
      '=>',
      matches.map((match) => `${match.disease_id}:${match.chunk_id}`).join(', ') || '(none)',
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

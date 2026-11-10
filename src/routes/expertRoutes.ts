import { Router } from 'express';
import {
  answerQuestion,
  approveNews,
  askQuestion,
  commentOnArticle,
  createPlan,
  deleteArticle,
  getConsultations,
  getExpertArticles,
  getExpertDesk,
  getExpertNewsQueue,
  getExpertQuestions,
  getExpertStats,
  getKnowledge,
  getMyQuestions,
  getPendingDiagnoses,
  getPublicArticle,
  listPublicArticles,
  needsRetake,
  publishArticle,
  rateArticle,
  rejectNews,
  reviewDiagnosis,
  saveKnowledge,
  saveNewsDraft,
  setBookingStatus,
  suggestNewsSource,
  toggleArticleLike,
  toggleArticleSave,
  togglePeer,
  togglePlan,
  updateArticle,
} from '../controllers/expertController';
import { authenticateToken, requireActiveAccount, requireRole } from '../middleware/authMiddleware';

/** `/api/expert` — the signed-in expert's console. */
const router = Router();
router.use(authenticateToken, requireActiveAccount, requireRole('EXPERT'));

router.get('/desk', getExpertDesk);
router.get('/stats', getExpertStats);

// Review queue
router.get('/diagnoses/pending', getPendingDiagnoses);
router.put('/diagnoses/:id/review', reviewDiagnosis);
router.post('/diagnoses/:id/needs-retake', needsRetake);

// Krishi Barta review
router.get('/news', getExpertNewsQueue);
router.post('/news', saveNewsDraft);
router.put('/news/:id', saveNewsDraft);
router.post('/news/:id/approve', approveNews);
router.post('/news/:id/reject', rejectNews);
router.post('/sources/suggest', suggestNewsSource);

// Knowledge base (the live RAG corpus)
router.get('/knowledge', getKnowledge);
router.put('/knowledge', saveKnowledge);

// Authored articles
router.get('/articles', getExpertArticles);
router.post('/articles', publishArticle);
router.put('/articles/:id', updateArticle);
router.delete('/articles/:id', deleteArticle);

// Farmer questions
router.get('/questions', getExpertQuestions);
router.post('/questions/:id/answer', answerQuestion);

// Consultations
router.get('/consultations', getConsultations);
router.post('/plans', createPlan);
router.put('/plans/:id', togglePlan);
router.put('/bookings/:id', setBookingStatus);

// Peers
router.post('/peers/:peerId/connect', togglePeer);

/**
 * `/api/articles` — farmer-facing. Deliberately outside the expert router:
 * anything mounted after the `requireRole('EXPERT')` guard above would have been
 * expert-only, which is how the advisory feed used to be unreachable by farmers.
 */
export const articleRouter: Router = Router();
articleRouter.use(authenticateToken, requireActiveAccount);
articleRouter.get('/', listPublicArticles);
articleRouter.get('/:id', getPublicArticle);
articleRouter.post('/:id/like', toggleArticleLike);
articleRouter.post('/:id/save', toggleArticleSave);
articleRouter.post('/:id/rating', rateArticle);
articleRouter.post('/:id/comments', commentOnArticle);

/** `/api/questions` — a farmer asking an expert. */
export const questionRouter: Router = Router();
questionRouter.use(authenticateToken, requireActiveAccount);
questionRouter.get('/', getMyQuestions);
questionRouter.post('/', askQuestion);

export default router;

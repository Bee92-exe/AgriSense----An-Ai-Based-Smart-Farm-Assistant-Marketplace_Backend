import { Request, Response } from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Initialize Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

export const askAiHandler = async (req: Request, res: Response) => {
  try {
    const { query } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Gemini API key is missing' });
    }

    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const systemPrompt = `You are "AgriBot" (এগ্রিবট), an agricultural expert assistant in Bangladesh.
    A farmer is asking you a question via voice.
    RULES:
    1. Reply strictly in Bengali (বাংলা).
    2. Keep your answer very concise (maximum 2-3 short sentences) because it will be read aloud by a Text-to-Speech engine.
    3. Do not use markdown like *, #, or bold texts. Use plain readable sentences.
    4. Provide the most direct, accurate agricultural advice based on the context of Bangladesh.
    
    Question: ${query}`;

    const result = await model.generateContent(systemPrompt);
    const response = await result.response;
    const text = response.text();

    res.json({ reply: text });
  } catch (error) {
    console.error('Error generating AI response:', error);
    res.status(500).json({ error: 'Failed to generate AI response' });
  }
};

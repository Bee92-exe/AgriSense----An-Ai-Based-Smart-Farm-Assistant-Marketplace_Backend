from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

app = FastAPI(title="AgriSense AI API", description="Crop Disease Detection ML Engine")

# Allow requests from the mobile app & node backend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class DiagnosisResponse(BaseModel):
    disease_name: str
    confidence: float
    treatment_steps: list[str]
    severity: str

@app.get("/")
def health_check():
    return {"status": "online", "service": "AgriSense AI Engine active"}

@app.post("/api/v1/diagnose", response_model=DiagnosisResponse)
async def diagnose_crop(file: UploadFile = File(...)):
    """
    Receives a crop image file, processes it through the PyTorch model, 
    and returns the detected disease with confidence scoring.
    """
    # 1. Read image bytes
    contents = await file.read()
    
    # [TO-DO: Implement PyTorch/TensorFlow Model Inference Here]
    # For now, returning mocked data for the Flutter UI prototype
    
    return DiagnosisResponse(
        disease_name="পাতা পোড়া রোগ (Leaf Blight)",
        confidence=94.5,
        severity="Moderate",
        treatment_steps=[
            "Remove and destroy infected leaves immediately.",
            "Apply Copper Oxychloride fungicide (2g/Liter).",
            "Avoid overhead watering to keep leaves dry."
        ]
    )

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)

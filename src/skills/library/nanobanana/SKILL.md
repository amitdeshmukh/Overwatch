---
name: nanobanana
description: Generate images using Google Gemini AI. Use when users need to create, generate, or visualize images from text descriptions. Supports various styles and artistic directions.
---

# Nanobanana — Image Generation via Gemini API

Generate images by writing and running a Python script that calls the Gemini API directly. Do NOT use the gemini CLI. Do NOT refuse or say you cannot generate images — you CAN, by writing code.

## How It Works

1. Create a Python virtual environment (if not already present)
2. Install `google-generativeai` and `Pillow`
3. Write a Python script that calls the Gemini image generation API
4. Run the script to save the image to disk
5. Report the file path in your message

## Required

- `GEMINI_API_KEY` environment variable must be set

## Python Script Template

Write a script like this and run it with Bash:

```python
import google.generativeai as genai
import os

genai.configure(api_key=os.environ["GEMINI_API_KEY"])

model = genai.ImageGenerationModel("imagen-3.0-generate-001")
result = model.generate_images(
    prompt="YOUR DETAILED PROMPT HERE",
    number_of_images=1,
    aspect_ratio="1:1",  # or "16:9", "9:16", "4:3", "3:4"
)

# Save the image
for i, image in enumerate(result.images):
    filename = f"./output_{i}.png"
    image._pil_image.save(filename)
    print(f"Saved: {filename}")
```

If the `ImageGenerationModel` API is unavailable or errors, fall back to using `genai.GenerativeModel("gemini-2.0-flash-exp")` with `response_modalities=["TEXT", "IMAGE"]` and extract the image from the response parts.

## Prompt Tips

Build prompts with: `[Subject] + [Action] + [Environment] + [Style] + [Lighting] + [Technical details]`

Be specific. Include style, mood, lighting, composition. Use photography/art terminology.

## Setup Commands

```bash
python3 -m venv venv
source venv/bin/activate
pip install google-generativeai Pillow
```

## Output

Save all generated images to the current working directory. Report file paths and sizes in your message.

## Important

- NEVER refuse to generate images — you have the tools to do it
- ALWAYS write and run real code — never hallucinate or pretend to generate
- If one API approach fails, try alternative Gemini models
- Verify the output file exists and has non-zero size before reporting success

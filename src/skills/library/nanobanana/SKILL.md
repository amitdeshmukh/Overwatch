---
name: nanobanana
description: Generate images using Google Gemini AI. Use when users need to create, generate, or visualize images from text descriptions. Supports various styles and artistic directions.
---

# Nanobanana Image Generation Skill

This skill generates images using Google's Gemini AI API. It converts text descriptions into visual content, supporting various styles, subjects, and artistic directions.

## When to Use This Skill

Activate this skill for:
- Creating original images from text descriptions
- Generating concept art or visualizations
- Producing marketing visuals or social media content
- Creating illustrations for documentation or presentations
- Generating product mockups or design ideas
- Any request involving "generate an image", "create a picture", "visualize", etc.

## Core Capabilities

### Image Generation
- **Text-to-Image**: Convert detailed descriptions into images
- **Style Control**: Apply artistic styles (realistic, cartoon, abstract, etc.)
- **Subject Variety**: People, objects, scenes, abstract concepts
- **Quality**: High-resolution output suitable for various uses

### Supported Styles
- Photorealistic
- Digital art
- Oil painting
- Watercolor
- Sketch/Line art
- 3D render
- Cartoon/Animation
- Abstract
- Minimalist

## Usage Framework

### 1. Understanding the Request

**Gather Key Information**:
- **Subject**: What is the main focus of the image?
- **Style**: What artistic style or medium is desired?
- **Mood/Tone**: What feeling should the image convey?
- **Context**: How will the image be used?
- **Specific Details**: Colors, composition, lighting, perspective

**Ask Clarifying Questions** if needed:
- "What style are you looking for? (realistic, artistic, abstract, etc.)"
- "What mood or feeling should this convey?"
- "Are there specific colors or elements that must be included?"
- "What will this image be used for?"

### 2. Crafting Effective Prompts

**Prompt Structure**:
```
[Subject] + [Action/Pose] + [Environment/Background] + [Style] + [Lighting/Mood] + [Technical Details]
```

**Example Good Prompts**:
- "A majestic golden retriever running through a sunlit meadow, photorealistic style, warm afternoon lighting, shallow depth of field, vibrant colors"
- "Modern minimalist logo design featuring a geometric mountain peak, flat design, navy blue and teal color scheme, clean lines, professional"
- "Futuristic cityscape at night, neon lights reflecting on wet streets, cyberpunk aesthetic, dramatic lighting, high contrast, 4K quality"

**Prompt Best Practices**:
- Be specific and descriptive
- Include style and mood keywords
- Specify technical aspects (lighting, composition, quality)
- Use adjectives to enhance detail
- Reference art styles or artists if relevant (but avoid copyrighted characters)

### 3. Making the API Request

**Required Environment Variable**:
- `GEMINI_API_KEY`: Your Google AI API key

**API Implementation**:

```javascript
import fetch from 'node-fetch';

async function generateImage(prompt: string, apiKey: string): Promise<{ imageUrl?: string; error?: string }> {
  try {
    // Gemini API endpoint for image generation
    const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-001:predict';

    const response = await fetch(`${endpoint}?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        instances: [
          {
            prompt: prompt
          }
        ],
        parameters: {
          sampleCount: 1,
          aspectRatio: "1:1", // or "16:9", "9:16", "4:3", "3:4"
          personGeneration: "allow_adult", // "dont_allow", "allow_adult", "allow_all"
          safetySetting: "block_some",
          // Optional quality/style parameters
          mode: "highQuality" // "highQuality" or "fast"
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { error: `Gemini API error (${response.status}): ${errorText}` };
    }

    const data = await response.json();

    // Extract image data from response
    // Response format may vary - adjust based on actual API response
    if (data.predictions && data.predictions[0]?.bytesBase64Encoded) {
      // If image is returned as base64
      const imageBase64 = data.predictions[0].bytesBase64Encoded;
      return { imageUrl: `data:image/png;base64,${imageBase64}` };
    } else if (data.predictions && data.predictions[0]?.mimeType) {
      // If image URL is provided
      return { imageUrl: data.predictions[0].url };
    }

    return { error: 'Unexpected response format from Gemini API' };
  } catch (error) {
    return { error: `Request failed: ${error.message}` };
  }
}

// Usage
const result = await generateImage(userPrompt, process.env.GEMINI_API_KEY);
if (result.error) {
  console.error('Image generation failed:', result.error);
} else {
  console.log('Image generated:', result.imageUrl);
}
```

### 4. Error Handling

**Common Issues and Solutions**:

| Error | Cause | Solution |
|-------|-------|----------|
| 401 Unauthorized | Invalid or missing API key | Check `GEMINI_API_KEY` environment variable |
| 400 Bad Request | Malformed prompt or parameters | Validate prompt format and parameters |
| 403 Forbidden | Policy violation or blocked content | Revise prompt to comply with content policies |
| 429 Rate Limit | Too many requests | Implement retry with exponential backoff |
| 500 Server Error | Gemini service issue | Retry after a delay, inform user of temporary issue |

**Content Policy Compliance**:
- Avoid generating violent, hateful, or explicit content
- Don't attempt to generate copyrighted characters or trademarked content
- Don't generate images of identifiable real people without consent
- Follow Google's AI Principles and usage policies

### 5. Response Format

**Success Response**:
```
✅ Image generated successfully!

Prompt used: [refined prompt]

[Image will be displayed inline or as downloadable link]

Additional options:
- Need adjustments? Let me know what to change
- Want a different style? I can regenerate with modifications
- Need multiple variations? I can create alternative versions
```

**Error Response**:
```
❌ Image generation failed

Error: [specific error message]

Troubleshooting:
- [Relevant suggestions based on error]
- [Alternative approach if applicable]

Would you like me to try again with a modified prompt?
```

## Advanced Features

### Aspect Ratios
- **1:1** - Square (default, good for social media)
- **16:9** - Landscape (presentations, YouTube thumbnails)
- **9:16** - Portrait (mobile, Instagram stories)
- **4:3** / **3:4** - Traditional photo formats

### Quality vs. Speed
- **highQuality**: Better detail, slower generation (~30-60s)
- **fast**: Quick generation, slightly lower quality (~10-20s)

### Batch Generation
For variations, you can adjust `sampleCount` parameter (typically 1-4)

## Examples

### Example 1: Marketing Visual
```
User: "I need a hero image for a coffee shop website"

Your prompt: "Warm and inviting coffee shop interior, morning sunlight streaming through large windows, professional barista preparing latte art, rustic wooden counter with fresh pastries, cozy atmosphere, photorealistic style, warm color palette with browns and creams, shallow depth of field"
```

### Example 2: Product Visualization
```
User: "Show me what a minimalist smart watch would look like"

Your prompt: "Sleek minimalist smart watch with circular OLED display, brushed titanium case, black leather strap, floating on clean white background, studio lighting, product photography style, high contrast, professional commercial shot, 4K quality"
```

### Example 3: Concept Art
```
User: "Create a sci-fi space station"

Your prompt: "Massive orbital space station floating above Earth, modular design with rotating sections, solar panels extending from central hub, small spacecraft docked at various ports, realistic sci-fi style, dramatic lighting from nearby sun, deep space background with stars, cinematic composition"
```

## Best Practices

1. **Be Descriptive**: More detail = better results
2. **Specify Style**: Always include an artistic style or reference
3. **Set the Mood**: Include lighting, atmosphere, and emotional tone
4. **Technical Terms**: Use photography/art terminology (bokeh, composition, perspective)
5. **Iterate**: Refine prompts based on output, don't expect perfection first try
6. **Stay Compliant**: Respect content policies and ethical guidelines

## Integration Notes

- The skill requires `GEMINI_API_KEY` in environment variables
- Images are returned as base64 data URLs or direct URLs
- Consider caching results to avoid regenerating identical prompts
- Implement rate limiting for production use
- Monitor API costs and usage quotas

## Troubleshooting

**If images aren't generating**:
1. Verify API key is valid and has correct permissions
2. Check API quota/billing status
3. Ensure prompt doesn't violate content policies
4. Try simplifying the prompt
5. Check network connectivity

**If quality is poor**:
1. Use `highQuality` mode parameter
2. Add more descriptive details to prompt
3. Specify professional photography/art terms
4. Reference specific styles or techniques

## Support

For Gemini API documentation: https://ai.google.dev/docs
For issues or questions: Check Google AI documentation or API status page

# GEMINI.md

This file is a portable Gemini / Antigravity / agy instruction file for OCR work.
Copy it as `GEMINI.md` into the directory where you want Gemini to perform OCR.

The goal is to make Gemini produce OCR Markdown as close as possible to mimi-ocr's
default `--target general` output.

## OCR Mode

Use the following instructions when the user asks you to OCR, transcribe, convert,
or extract text from images, PDFs, screenshots, scanned pages, or page images.

For PDF input, do not extract or rely on embedded/selectable PDF text. Treat each
PDF page as a visual page image and recognize the characters from the rendered
page appearance. If tools are available, render or view the PDF pages as images
and perform visual OCR on those page images. Do not use `pdftotext`, copy/paste
text layers, hidden text, metadata, outlines, accessibility text, or any other
embedded text source as the OCR result.

If the user explicitly asks for `houhi`, `law-office`, `legal pleading style`,
or a custom legal/court document template, follow the user's explicit request.
Otherwise, use the general OCR style below.

## General Document Context

# CONTEXT: General Document
- **Format**: Standard Japanese document.
- **Line Breaks**: Merge lines within paragraphs.
- **Headings**: Use standard Markdown headings (#, ##, ###) based on the document structure.

## Main OCR Prompt

# ROLE
High-precision OCR engine converting Japanese PDF pages to clean Markdown.

# INPUT
One or more pages of a Japanese document.

For PDFs, the input must be interpreted as rendered page images. Ignore embedded
PDF text layers even if they exist, because the expected output is visual OCR,
not text-layer extraction.

If the actual number of pages is known, use that number for page markers.
If the actual number of pages is not explicitly given, infer it from the provided
images/files and number the pages sequentially from 1.

# OUTPUT RULES
1. **Markdown Only**: No conversational text.
2. **No Skipping**: Even if the first page starts mid-sentence or mid-paragraph (continuation from a previous unprovided page), transcribe it completely from the very first character.
3. **Page Markers**:
   - **Start**: At the start of content, output `### -- Begin Page N {StartStatus} --`.
     - N: Page index in the provided input, starting from 1.
     - {StartStatus}: "(Continuation)" if the text at the very top of the page is a direct continuation of a paragraph from the previous page (cut off mid-sentence without a line break), else empty.
   - **End**: At the end of content, output `### -- End {PrintedPageInfo} {EndStatus} --`.
     - {PrintedPageInfo}: "(Printed Page X)" if a printed page number X is found (CONVERT Kanji/Roman to Arabic). If not found, leave empty.
     - {EndStatus}: "(Continuation)" if the paragraph is cut off mid-sentence and continues to the next page without an explicit line break, else empty.
4. **Transcription Rules**:
   - **No Indentation**: Standard Markdown paragraphs.
   - **Numbers**: Convert ALL full-width numbers to half-width (e.g., "１" -> "1").
   - **Corrections**: Fix obvious OCR errors (0 vs O). Keep original typos with `(-- as is)`.
   - **Visuals**: If there are photos or diagrams, provide an explanation for them in Japanese formatted as `(--! Explanation)`.
   - **Exclusions**: Omit printed page numbers from body.
     - **Redactions**: Replace blacked-out or redacted parts with "■".
     - **Margins**:
     - Headings text in margins: Format as `(--# Text)`.
     - Annotations/Notes in margins: Format as `(--* Text)`.

## Raw OCR Text Formatting Mode

Use this section only when the user gives already-extracted raw OCR text and asks
you to format or clean it into mimi-ocr-style Markdown.

# ROLE
High-precision document formatting engine converting raw OCR text to clean Markdown.

# INPUT
Raw text extracted by an OCR engine, separated by page markers. The content may contain some OCR errors or formatting artifacts.

# OUTPUT RULES
1. **Markdown Only**: No conversational text.
2. **Formatting**: Reconstruct the original document's structure into clean Markdown paragraphs. Merge lines that are part of the same logical sentence.
3. **Headings**: Identify probable headings and format them with Markdown (#, ##, etc.).
4. **Errors**: Correct obvious OCR text recognition errors using surrounding context if possible.
5. **Numbers**: Convert ALL full-width numbers to half-width (e.g., "１" -> "1").
6. **Page Markers**:
   - Retain the exact same `### -- Begin Page N --` and `### -- End --` markers around each page's content in your output.
7. **No Skipping**: Format the entire input text completely from the beginning to the end.

## Important Compatibility Notes

- The default style is `general`, not `houhi`.
- For PDFs, perform visual recognition from rendered pages. Do not extract embedded PDF text.
- Do not introduce legal pleading templates unless the user explicitly asks for them.
- Do not summarize, explain, or evaluate the legal meaning of the document.
- Output the OCR Markdown itself, not a report about the OCR.
- Preserve the mimi-ocr page marker style exactly.

.PHONY: pdf clean-pdf help

## Generate the book as a PDF (output: claude-code-from-source.pdf)
pdf:
	@command -v md-to-pdf >/dev/null 2>&1 || { echo "Installing md-to-pdf..."; npm install -g md-to-pdf; }
	@echo "Building book-combined.md..."
	@node scripts/build-pdf.js
	@echo "Rendering PDF..."
	@md-to-pdf --config-file .md-to-pdf.config.js book-combined.md
	@mv book-combined.pdf claude-code-from-source.pdf
	@echo "✔ claude-code-from-source.pdf"

## Remove generated PDF artifacts
clean-pdf:
	@rm -f book-combined.md claude-code-from-source.pdf
	@echo "✔ cleaned"

## Show available targets
help:
	@grep -E '^##' Makefile | sed 's/## /  /'

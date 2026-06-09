import { jsPDF } from "jspdf";
import { toPng } from "html-to-image";

export async function exportToPdf(elementId: string, fileName: string) {
  const element = document.getElementById(elementId);
  if (!element) {
    console.error("PDF Export error: Element not found", elementId);
    return;
  }

  // Hide the controls/buttons before capturing if necessary
  // For now, capture the whole container
  try {
    const dataUrl = await toPng(element, { 
      pixelRatio: 2, 
      backgroundColor: '#0f172a', // or maybe just transparent, usually needs to cover
      skipFonts: false
    });
    
    // We need to get width and height for proper PDF scaling. We can load it into an image
    const img = new Image();
    img.src = dataUrl;
    await new Promise((resolve) => {
      img.onload = resolve;
    });

    const pdf = new jsPDF("landscape", "mm", "a4");
    const pdfWidth = pdf.internal.pageSize.getWidth();
    const pdfHeight = (img.height * pdfWidth) / img.width;
    
    pdf.addImage(dataUrl, "PNG", 0, 0, pdfWidth, pdfHeight);
    pdf.save(`${fileName}.pdf`);
  } catch (error) {
    console.error("Error generating PDF:", error);
  }
}


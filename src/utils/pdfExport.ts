import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { toPng } from "html-to-image";

export async function exportToPdf(
  elementId: string, 
  fileName: string,
  networkNodes: any[] = [],
  clientNodes: any[] = []
) {
  const element = document.getElementById(elementId);
  if (!element) {
    console.error("PDF Export error: Element not found", elementId);
    return;
  }

  // 1. Hide coverage layer and apply grayscale
  const coverageLayer = document.getElementById('coverage-layer');
  const originalCoverageDisplay = coverageLayer ? coverageLayer.style.display : '';
  if (coverageLayer) coverageLayer.style.display = 'none';

  const originalFilter = element.style.filter;
  element.style.filter = 'grayscale(100%)';

  try {
    const dataUrl = await toPng(element, { 
      pixelRatio: 2, 
      backgroundColor: '#0f172a',
      skipFonts: false
    });
    
    // Restore original styles immediately
    if (coverageLayer) coverageLayer.style.display = originalCoverageDisplay;
    element.style.filter = originalFilter;

    const img = new Image();
    img.src = dataUrl;
    await new Promise((resolve) => {
      img.onload = resolve;
    });

    // Create PDF in landscape mode
    const pdf = new jsPDF("landscape", "mm", "a4");
    const pdfWidth = pdf.internal.pageSize.getWidth();
    const pdfHeight = (img.height * pdfWidth) / img.width;
    
    // Add the image of the canvas
    pdf.addImage(dataUrl, "PNG", 0, 0, pdfWidth, pdfHeight);

    // 2. Add second page for the statistics table if there are nodes
    if (networkNodes.length > 0 || clientNodes.length > 0) {
      // Map device types to Vietnamese
      const getDeviceTypeName = (type: string) => {
        switch(type) {
          case 'isp_modem': return 'ISP Modem';
          case 'router_wifi': return 'Router Wi-Fi';
          case 'switch': return 'Switch';
          case 'ap': return 'Access Point';
          default: return 'Thiet bi mang (' + type + ')';
        }
      };

      const tableData = [];
      let counts = {
        isp_modem: 0,
        router_wifi: 0,
        switch: 0,
        ap: 0,
        client: 0
      };

      // Populate Network Nodes
      networkNodes.forEach(node => {
        counts[node.type] = (counts[node.type] || 0) + 1;
        let modeDisplay = node.mode === 'router' ? 'Router' : 'Bridge';
        if (node.isMeshEnabled) {
          if (node.meshRole === 'controller') {
            modeDisplay += ' / Mesh Controller';
          } else if (node.meshRole === 'agent') {
            modeDisplay += ' / Mesh Agent';
          }
        }
        tableData.push([
          node.name || 'Khong ten',
          getDeviceTypeName(node.type),
          modeDisplay,
          node.lanIp || node.bridgeIp || 'DHCP',
          node.hasWifi ? `Co (SSID: ${node.ssid})` : 'Khong'
        ]);
      });

      // Populate Client Nodes
      clientNodes.forEach(client => {
        counts.client += 1;
        tableData.push([
          client.name || 'Khong ten',
          'Thiet bi cuoi',
          client.connectionType === 'wired' ? 'Co day (LAN)' : 'Khong day (Wi-Fi)',
          client.ipAddress || 'DHCP',
          '-'
        ]);
      });

      // Count Table
      const summaryTableData = [
        ['ISP Modem', counts.isp_modem],
        ['Router Wi-Fi', counts.router_wifi],
        ['Switch', counts.switch],
        ['Access Point', counts.ap],
        ['Thiet bi cuoi (Client)', counts.client]
      ];

      pdf.addPage();
      pdf.setFontSize(16);
      pdf.text("Bang Thong Ke Thiet Bi", 14, 20);

      autoTable(pdf, {
        startY: 30,
        head: [['Loai Thiet Bi', 'So Luong']],
        body: summaryTableData,
        theme: 'grid',
        headStyles: { fillColor: [41, 128, 185] },
        styles: { font: "helvetica", fontSize: 10 }
      });

      autoTable(pdf, {
        // @ts-ignore
        startY: (pdf as any).lastAutoTable.finalY + 15,
        head: [['Ten Thiet Bi', 'Loai', 'Che Do (Mode)', 'IP Address', 'Wi-Fi']],
        body: tableData,
        theme: 'grid',
        headStyles: { fillColor: [46, 204, 113] },
        styles: { font: "helvetica", fontSize: 10 }
      });
    }

    pdf.save(`${fileName}.pdf`);
  } catch (error) {
    // Restore original styles on error too
    if (coverageLayer) coverageLayer.style.display = originalCoverageDisplay;
    element.style.filter = originalFilter;
    console.error("Error generating PDF:", error);
  }
}



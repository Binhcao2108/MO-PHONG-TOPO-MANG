import defaultData from './defaultData.json';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Server,
  Layers,
  Wifi,
  Smartphone,
  Settings,
  Trash2,
  Plus,
  Minus,
  Hand,
  X,
  Check,
  AlertTriangle,
  Play,
  Info,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Database,
  Router as RouterIcon,
  Tv,
  Camera,
  Radio,
  Image as ImageIcon,
  Download,
  Upload,
  Save,
  FolderOpen,
  Lock,
  CloudDownload
} from 'lucide-react';
import { exportToPdf } from './utils/pdfExport';
import { exportToJson, importFromJson } from './utils/fileUtils';

// --- DATA TYPE DEFINITIONS ---
export interface DeviceSpecs {
  txPower: number; // dBm
  gain: number;    // dBi
}

export type DeviceType = 'isp_modem' | 'router_wifi' | 'switch' | 'ap';

export interface NetworkNode {
  id: string;
  type: DeviceType;
  name: string;
  icon: 'Server' | 'Layers' | 'Wifi' | 'RouterIcon';
  colorTheme: 'sky' | 'emerald' | 'slate' | 'purple';
  x: number; // % (0-100)
  y: number; // % (0-100)
  hasWifi: boolean;
  specs: DeviceSpecs;
  mode: 'router' | 'bridge';
  ssid: string;
  ports: number;
  isMeshEnabled: boolean;
  meshRole: 'controller' | 'agent';
  uplinkId: string; // 'none' hoặc id node khác
  uplinkType: 'wired' | 'wireless';
  isPoe: boolean;
  wanIpMode: 'dhcp' | 'static';
  wanIp: string;
  lanIp: string;
  bridgeIpMode: 'dhcp' | 'static';
  bridgeIp: string;
  customImage?: string;
  hideLabel?: boolean;
}

export interface ClientNode {
  id: string;
  name: string;
  type: 'client';
  x: number; // % (0-100)
  y: number; // % (0-100)
  connectedTo: string | null; // ID của NetworkNode hoặc null
  forceConnect: 'auto' | string; // 'auto' hoặc ID của NetworkNode
  currentRssi: number;
  rssiMap: Record<string, number>;
  ipMode: 'dhcp' | 'static';
  ipAddress: string;
  clientType?: 'phone' | 'fpt_box' | 'fpt_camera';
  connectionType?: 'wifi' | 'wired';
  wiredTo?: string | null;
  support80211k?: boolean;
  support80211v?: boolean;
  support80211r?: boolean;
  customImage?: string;
  hideLabel?: boolean;
}

export interface Wall {
  x: number; // %
  y: number; // %
  w: number; // %
  h: number; // %
  type: 'brick' | 'concrete' | 'glass';
  groupId: number;
}

export interface AppLog {
  id: string;
  timestamp: string;
  title: string;
  desc: string;
  type: 'info' | 'success' | 'warning' | 'error';
}

// --- CONSTANTS ---
const CANVAS_ASPECT_RATIO = 16 / 9;
const MIN_RSSI = -95;
const DISCONNECT_RSSI = -85; // Ngưỡng đứt kết nối hoàn toàn
const wallPenalties = { brick: 8, concrete: 15, glass: 2 };

// --- HELPER FUNCTIONS FOR INTERSECTION ---
function lineIntersects(
  x1: number, y1: number, x2: number, y2: number,
  x3: number, y3: number, x4: number, y4: number
): boolean {
  const den = (y4 - y3) * (x2 - x1) - (x4 - x3) * (y2 - y1);
  if (den === 0) return false;
  const uA = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / den;
  const uB = ((x2 - x1) * (y1 - y3) - (y2 - y1) * (x1 - x3)) / den;
  return (uA >= 0 && uA <= 1 && uB >= 0 && uB <= 1);
}

function getWallAttenuation(x1: number, y1: number, x2: number, y2: number, walls: Wall[]): number {
  let penalty = 0;
  for (const w of walls) {
    const left = lineIntersects(x1, y1, x2, y2, w.x, w.y, w.x, w.y + w.h);
    const right = lineIntersects(x1, y1, x2, y2, w.x + w.w, w.y, w.x + w.w, w.y + w.h);
    const top = lineIntersects(x1, y1, x2, y2, w.x, w.y, w.x + w.w, w.y);
    const bot = lineIntersects(x1, y1, x2, y2, w.x, w.y + w.h, w.x + w.w, w.y + w.h);
    if (left || right || top || bot) {
      penalty += wallPenalties[w.type] || 0;
    }
  }
  return penalty;
}

// Tính khoảng cách thực tế dựa trên % tọa độ canvas (mô phỏng)
function calculateDistanceMeters(x1: number, y1: number, x2: number, y2: number, canvasWidthMeters: number): number {
  const canvasHeightMeters = canvasWidthMeters / CANVAS_ASPECT_RATIO;
  const dx_m = ((x2 - x1) / 100) * canvasWidthMeters;
  const dy_m = ((y2 - y1) / 100) * canvasHeightMeters;
  return Math.sqrt(dx_m * dx_m + dy_m * dy_m);
}

// Đo mồi công suất phát (FSPL) - Đã căn chỉnh suy hao môi trường thực tế ~35dB/decade
function calculateRealRssi(distanceMeters: number, txPower: number, txGain: number): number {
  const d = distanceMeters < 0.1 ? 0.1 : distanceMeters;
  // Based on user feedback: 20-22m distance -> -58 to -60 dBm
  const fspl = 38 + 35 * Math.log10(d);
  return Math.floor(txPower + txGain - fspl);
}

// Tìm ID của Mesh Controller quản trị cho một AP (Tru vết miền quản trị Mesh độc lập)
function getControllerId(nodeId: string, nodes: Record<string, NetworkNode>): string | null {
  const node = nodes[nodeId];
  if (!node || !node.isMeshEnabled) return null;
  if (node.meshRole === 'controller') return node.id;

  const visited = new Set<string>();
  let current = node;
  while (current && current.uplinkId && current.uplinkId !== 'none') {
    if (visited.has(current.id)) break;
    visited.add(current.id);

    const parent = nodes[current.uplinkId];
    if (!parent) break;
    if (parent.isMeshEnabled && parent.meshRole === 'controller') {
      return parent.id;
    }
    current = parent;
  }
  return null;
}

// --- SAMPLE INITIAL DATABASE ---
const defaultNetworkNodes: Record<string, NetworkNode> = defaultData.networkNodes as any;

const defaultClientNodes: Record<string, ClientNode> = defaultData.clientNodes as any;

const defaultWalls: Wall[] = defaultData.walls as any;


export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loginId, setLoginId] = useState("");
  const [loginPass, setLoginPass] = useState("");
  const [loginError, setLoginError] = useState(false);

  // --- STATE ---
  const [iconTab, setIconTab] = useState<'modem' | 'router' | 'switch' | 'ap'>('modem');

  // --- THƯ VIỆN THIẾT BỊ LƯU TRỮ TỰ ĐỊNH NGHĨA (USER DEVICE TEMPLATES) ---
  const [deviceTemplates, setDeviceTemplates] = useState<Array<{
    id: string;
    name: string;
    category: 'modem' | 'router' | 'switch' | 'ap';
    image: string;
  }>>(() => {
    const saved = localStorage.getItem('wifi-sim-templates');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        // Fallback below
      }
    }
    return defaultData.deviceTemplates as any;
  });

  // State nhập liệu cho form thêm thiết bị vào thư viện
  const [newTemplateName, setNewTemplateName] = useState('');
  const [newTemplateCategory, setNewTemplateCategory] = useState<'modem' | 'router' | 'switch' | 'ap'>('modem');
  const [newTemplateImage, setNewTemplateImage] = useState('');

  const [networkNodes, setNetworkNodes] = useState<Record<string, NetworkNode>>(() => {
    const saved = localStorage.getItem('wifi-sim-nodes');
    return saved ? JSON.parse(saved) : defaultNetworkNodes;
  });

  const [clientNodes, setClientNodes] = useState<Record<string, ClientNode>>(() => {
    const saved = localStorage.getItem('wifi-sim-clients');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        Object.keys(parsed).forEach(k => {
          if (!parsed[k].clientType) parsed[k].clientType = 'phone';
          if (!parsed[k].connectionType) parsed[k].connectionType = 'wifi';
          if (parsed[k].wiredTo === undefined) parsed[k].wiredTo = null;
          if (parsed[k].support80211k === undefined) parsed[k].support80211k = true;
          if (parsed[k].support80211v === undefined) parsed[k].support80211v = true;
          if (parsed[k].support80211r === undefined) parsed[k].support80211r = true;
        });
        return parsed;
      } catch (e) {
        return defaultClientNodes;
      }
    }
    return defaultClientNodes;
  });

  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [customWalls, setCustomWalls] = useState<Wall[]>(() => {
    const saved = localStorage.getItem('wifi-sim-walls');
    return saved ? JSON.parse(saved) : defaultWalls;
  });

  const [logs, setLogs] = useState<AppLog[]>([]);
  const [autoRoam, setAutoRoam] = useState(true);
  const [isHandulating, setIsHandulating] = useState(false); // Đang nổ ra xử lý thủ công
  const [isSidebarEnvOpen, setIsSidebarEnvOpen] = useState(true);
  const [isSidebarRoamOpen, setIsSidebarRoamOpen] = useState(true);

  // Custom confirmation modal state for iframe compatibility
  const [confirmAction, setConfirmAction] = useState<{
    message: string;
    onConfirm: () => void;
    title?: string;
    btnText?: string;
    btnColor?: string;
  } | null>(null);

  // Canvas Viewport State (Zoom & Pan)
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isCanvasPanning, setIsCanvasPanning] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0 });

  // Scale and sizing State
  const [canvasScale, setCanvasScale] = useState<number>(60);
  const canvasHeightMeters = canvasScale / CANVAS_ASPECT_RATIO;
  
  // Tùy chỉnh kích thước
  const [iconScale, setIconScale] = useState<number>(40);
  const [wallThicknessScale, setWallThicknessScale] = useState<number>(0.25);

  // Vẽ Tường State
  const [editorLayout, setEditorLayout] = useState<'none' | 'custom'>('custom');
  const [selectedTool, setSelectedTool] = useState<'pan' | 'line' | 'rect' | 'eraser'>('pan');
  const [selectedMaterial, setSelectedMaterial] = useState<'brick' | 'concrete' | 'glass'>('brick');
  const [fixedDimLength, setFixedDimLength] = useState<string>('');
  const [fixedDimRectW, setFixedDimRectW] = useState<string>('');
  const [fixedDimRectH, setFixedDimRectH] = useState<string>('');
  const [isDrawingStep2, setIsDrawingStep2] = useState(false);
  const [drawStart, setDrawStart] = useState({ x: 0, y: 0 });
  const [previewWall, setPreviewWall] = useState<Omit<Wall, 'groupId'> | null>(null);
  const currentDrawGroupId = useRef(defaultWalls.length + 1);

  // Kéo thả Node State
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);

  // Setup Modal cấu hình
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [modalData, setModalData] = useState<{
    name: string;
    mode: 'router' | 'bridge';
    wanIpMode: 'dhcp' | 'static';
    wanIp: string;
    lanIp: string;
    bridgeIpMode: 'dhcp' | 'static';
    bridgeIp: string;
    ssid: string;
    ports: number;
    isMeshEnabled: boolean;
    meshRole: 'controller' | 'agent';
    uplinkId: string;
    uplinkType: 'wired' | 'wireless';
    isPoe: boolean;
    txPower: number;
    gain: number;
    forceConnect: string;
    ipMode: 'dhcp' | 'static';
    ipAddress: string;
    hasWifi: boolean;
    clientType?: 'phone' | 'fpt_box' | 'fpt_camera';
    connectionType?: 'wifi' | 'wired';
    wiredTo?: string | null;
    support80211k?: boolean;
    support80211v?: boolean;
    support80211r?: boolean;
    customImage?: string;
    hideLabel?: boolean;
  } | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);

  // Ép kiểu danh sách rõ ràng để tránh lỗi TS2339 (unknown type property access)
  const networkNodeList = Object.values(networkNodes) as NetworkNode[];
  const clientNodeList = Object.values(clientNodes) as ClientNode[];

  // --- KEYBOARD SHORTCUTS ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isDrawingStep2) {
          setIsDrawingStep2(false);
          setPreviewWall(null);
        } else if (selectedNodeId) {
          setSelectedNodeId(null);
          setModalData(null);
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        if (editorLayout === 'custom') {
          setCustomWalls(prev => {
            if (prev.length === 0) return prev;
            const lastGroupId = prev[prev.length - 1].groupId;
            return prev.filter(w => w.groupId !== lastGroupId);
          });
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isDrawingStep2, editorLayout, selectedNodeId]);

  // --- LOCAL PERSISTENCE ---
  useEffect(() => {
    localStorage.setItem('wifi-sim-nodes', JSON.stringify(networkNodes));
  }, [networkNodes]);

  useEffect(() => {
    localStorage.setItem('wifi-sim-clients', JSON.stringify(clientNodes));
  }, [clientNodes]);

  useEffect(() => {
    localStorage.setItem('wifi-sim-walls', JSON.stringify(customWalls));
  }, [customWalls]);

  useEffect(() => {
    localStorage.setItem('wifi-sim-templates', JSON.stringify(deviceTemplates));
  }, [deviceTemplates]);

  // --- LOGGER ---
  const addLog = useCallback((title: string, desc: string, type: 'info' | 'success' | 'warning' | 'error' = 'info') => {
    const timestamp = new Date().toLocaleTimeString();
    const newLog: AppLog = {
      id: 'LOG_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      timestamp,
      title,
      desc,
      type
    };
    setLogs(prev => [newLog, ...prev].slice(0, 50)); // Lưu tối đa 50 dải
  }, []);

  // Log chào mừng ban đầu
  useEffect(() => {
    addLog(
      'Hệ thống khởi tạo',
      'Chào mừng bạn đến với mô phỏng Wi-Fi Topology & Roaming của Kỹ Thuật Công Nghệ. Thêm thiết bị mạng để lập cấu trúc.',
      'success'
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- TẢI THƯ VIỆN/DỮ LIỆU TỰ ĐỘNG TỪ GOOGLE DRIVE KHI RENDER ---
  useEffect(() => {
    const fetchDriveData = async () => {
      try {
        const proxyUrl = '/api/fetch-drive';
        
        const response = await fetch(proxyUrl);
        if (response.ok) {
          const data = await response.json();
          let imported = false;

          if (data.networkNodes) { setNetworkNodes(data.networkNodes); imported = true; }
          if (data.clientNodes) { setClientNodes(data.clientNodes); imported = true; }
          if (data.walls) { setCustomWalls(data.walls); imported = true; }
          if (data.deviceTemplates) { setDeviceTemplates(data.deviceTemplates); imported = true; }

          if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && 'category' in data[0]) {
            setDeviceTemplates(prev => {
              const existingIds = new Set(prev.map(t => t.id));
              const newTemplates = data.filter(t => !existingIds.has(t.id));
              return [...prev, ...newTemplates];
            });
            imported = true;
          }

          if (imported) {
            addLog('System', 'Đã tải và cập nhật dữ liệu tự động từ Google Drive', 'success');
          }
        }
      } catch (err) {
        console.error('Lỗi khi tải dữ liệu từ Google Drive:', err);
      }
    };

    // Chỉ thực hiện tải 1 lần lúc startup nếu chưa có template ngoài mặc định, 
    // hoặc có thể tải nạp đè. Ở đây ta tải luôn.
    fetchDriveData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- TRUY VẾT IP DHCP GATEWAY ---
  const getSubnetGatewayForNode = useCallback((nodeId: string): string => {
    let visited = new Set<string>();
    let currentNodeId = nodeId;
    let subnet = '192.168.1';

    while (currentNodeId && currentNodeId !== 'none') {
      if (visited.has(currentNodeId)) break;
      visited.add(currentNodeId);

      const node = networkNodes[currentNodeId];
      if (!node) break;

      if (node.mode === 'router') {
        const parts = (node.lanIp || '192.168.1.1').split('.');
        if (parts.length >= 3) {
          subnet = `${parts[0]}.${parts[1]}.${parts[2]}`;
        }
        break;
      }
      currentNodeId = node.uplinkId;
    }
    return subnet;
  }, [networkNodes]);

  const getDHCPAddressForNode = useCallback((node: NetworkNode): string => {
    if (node.mode === 'router') {
      return node.lanIp || '192.168.1.1';
    }
    const subnet = getSubnetGatewayForNode(node.id);
    const suffix = (parseInt(node.id.replace(/[^\d]/g, '')) % 100) + 10;
    return `${subnet}.${suffix}`;
  }, [getSubnetGatewayForNode]);

  const getDHCPAddressForClient = useCallback((client: ClientNode): string => {
    if (client.connectionType === 'wired') {
      if (!client.wiredTo || client.wiredTo === 'none') return 'Mất liên kết (No Cable)';
      const subnet = getSubnetGatewayForNode(client.wiredTo);
      const suffix = (parseInt(client.id.replace(/[^\d]/g, '')) % 100) + 100;
      return `${subnet}.${suffix}`;
    } else {
      if (!client.connectedTo) return 'Mất liên kết (No IP)';
      const subnet = getSubnetGatewayForNode(client.connectedTo);
      const suffix = (parseInt(client.id.replace(/[^\d]/g, '')) % 100) + 100;
      return `${subnet}.${suffix}`;
    }
  }, [getSubnetGatewayForNode]);

  // --- PHYSICS ENGINE -- CẬP NHẬT RSSI & ROAMING ---
  const updateNetworkState = useCallback(() => {
    setClientNodes(prevClients => {
      let changed = false;
      const nextClients = { ...prevClients };

      const currentNetworkNodes = Object.values(networkNodes) as NetworkNode[];

      Object.keys(nextClients).forEach(cliId => {
        const cli = { ...nextClients[cliId] };
        let bestDevId: string | null = null;
        let maxRssi = MIN_RSSI;
        const rssiMap: Record<string, number> = {};

        // Tính RSSI từ client tới các AP/Router Wi-Fi
        currentNetworkNodes.forEach(dev => {
          if (!dev.hasWifi) return;
          const distMeters = calculateDistanceMeters(cli.x, cli.y, dev.x, dev.y, canvasScale);
          const wallAtten = getWallAttenuation(cli.x, cli.y, dev.x, dev.y, customWalls);
          const finalRssi = Math.max(
            MIN_RSSI,
            calculateRealRssi(distMeters, dev.specs.txPower, dev.specs.gain) - wallAtten
          );
          rssiMap[dev.id] = finalRssi;

          if (finalRssi > maxRssi) {
            maxRssi = finalRssi;
            bestDevId = dev.id;
          }
        });

        cli.rssiMap = rssiMap;
        const prevConnectedTo = cli.connectedTo;

        if (cli.connectionType === 'wired') {
          cli.connectedTo = null;
          cli.currentRssi = 0;
        } else {
          if (cli.forceConnect !== 'auto' && networkNodes[cli.forceConnect]) {
            // Ép kết nối
            cli.connectedTo = cli.forceConnect;
          } else if (autoRoam && !isHandulating) {
            const supportK = cli.support80211k !== false;
            const supportV = cli.support80211v !== false;

            // 802.11v (BSS transition): AP chủ động chuyển vùng sớm hơn (ngưỡng cao nhạy bén hơn)
            const triggerThreshold = supportV ? -68 : -74;
            // 802.11k (Neighbor report): Giảm delta cần thiết vì đã có bản đồ AP lân cận xác thực trước
            const requiredDelta = supportK ? 2 : 5;

            const currentRssiToNode = cli.connectedTo && rssiMap[cli.connectedTo] ? rssiMap[cli.connectedTo] : MIN_RSSI;

            if (bestDevId && maxRssi > DISCONNECT_RSSI) {
              if (!cli.connectedTo || currentRssiToNode <= DISCONNECT_RSSI) {
                // Kết nối mới hoàn toàn nếu chưa nối hoặc sóng cũ sụt quá đứt mạng
                cli.connectedTo = bestDevId;
              } else if (currentRssiToNode < triggerThreshold && bestDevId !== cli.connectedTo && maxRssi > currentRssiToNode + requiredDelta) {
                const currDev = networkNodes[cli.connectedTo];
                const bestDev = networkNodes[bestDevId];
                // Roaming mượt chỉ khi CẢ HAI thiết bị đều bật Mesh VÀ cùng một Mesh Controller quản lý!
                if (currDev && bestDev && currDev.isMeshEnabled && bestDev.isMeshEnabled) {
                  const ctrl1 = getControllerId(currDev.id, networkNodes);
                  const ctrl2 = getControllerId(bestDev.id, networkNodes);
                  if (ctrl1 && ctrl2 && ctrl1 === ctrl2) {
                    cli.connectedTo = bestDevId;
                  }
                }
              }
            } else {
              cli.connectedTo = null;
            }
          } else {
            // Không auto roaming, kiểm tra xem trạm cũ có hoạt động
            if (cli.connectedTo && (!rssiMap[cli.connectedTo] || rssiMap[cli.connectedTo] <= DISCONNECT_RSSI)) {
              cli.connectedTo = null;
            }
          }

          cli.currentRssi = cli.connectedTo && rssiMap[cli.connectedTo] ? rssiMap[cli.connectedTo] : MIN_RSSI;
        }

        // Nhật ký thông tin roaming tự động
        if (cli.connectionType !== 'wired' && cli.connectedTo !== prevConnectedTo && autoRoam && !isHandulating) {
          if (!cli.connectedTo) {
            addLog(
              'Mất sóng',
              `Thiết bị ${cli.name} đã văng khỏi vùng phủ sóng (RSSI sụt quá ${DISCONNECT_RSSI}dBm)`,
              'error'
            );
          } else if (!prevConnectedTo) {
            const nextDev = networkNodes[cli.connectedTo];
            if (nextDev) {
              addLog('Kết nối', `Thiết bị ${cli.name} đã gia nhập sóng trạm ${nextDev.name}`, 'success');
            }
          } else {
            const oldDev = networkNodes[prevConnectedTo];
            const nextDev = networkNodes[cli.connectedTo];
             if (oldDev && nextDev) {
               const ctrlOld = getControllerId(oldDev.id, networkNodes);
               const ctrlNext = getControllerId(nextDev.id, networkNodes);
               const isSameController = ctrlOld && ctrlNext && ctrlOld === ctrlNext;

               if (oldDev.isMeshEnabled && nextDev.isMeshEnabled && isSameController) {
                 const supportR = cli.support80211r !== false;
                 const controllerName = networkNodes[ctrlOld]?.name || 'Controller';
                 if (supportR) {
                   addLog(
                     'Auto Roaming (FT 802.11r)',
                     `Seamless Fast Roaming: Thiết bị ${cli.name} chuyển vùng mượt bằng công nghệ 802.11r từ ${oldDev.name} sang ${nextDev.name} dưới chung một miền quản lý bởi trạm [${controllerName}] chỉ mất ~15ms và 0% rớt gói (RSSI: ${rssiMap[oldDev.id]}dBm -> ${rssiMap[nextDev.id]}dBm).`,
                     'success'
                   );
                 } else {
                   addLog(
                     'Auto Roaming (Mesh)',
                     `Mesh Roaming: Thiết bị ${cli.name} chuyển vùng từ ${oldDev.name} sang ${nextDev.name} (chung trạm điều khiển [${controllerName}]) mất ~280ms, có thể rớt nhẹ vài gói tin (RSSI: ${rssiMap[oldDev.id]}dBm -> ${rssiMap[nextDev.id]}dBm).`,
                     'success'
                   );
                 }
               } else {
                 addLog(
                   'Chuyển mạng độc lập',
                   `Thiết bị ${cli.name} chuyển vùng chậm, ngắt sóng hoàn toàn (~2.2 giây) để kết nối lại từ AP độc lập ${oldDev.name} sang AP mới tốt hơn: ${nextDev.name} (Hai AP thuộc hai trạm Controller khác nhau, không hỗ trợ chuyển dữ liệu Seamless Roaming!)`,
                   'warning'
                 );
               }
             }
          }
        }

        // Kiểm tra xem có đổi dữ liệu để set state không
        if (
          cli.connectedTo !== prevConnectedTo ||
          cli.currentRssi !== prevClients[cliId]?.currentRssi ||
          cli.connectionType !== prevClients[cliId]?.connectionType ||
          cli.wiredTo !== prevClients[cliId]?.wiredTo ||
          cli.support80211k !== prevClients[cliId]?.support80211k ||
          cli.support80211v !== prevClients[cliId]?.support80211v ||
          cli.support80211r !== prevClients[cliId]?.support80211r ||
          JSON.stringify(cli.rssiMap) !== JSON.stringify(prevClients[cliId]?.rssiMap)
        ) {
          nextClients[cliId] = cli;
          changed = true;
        }
      });

      return changed ? nextClients : prevClients;
    });
  }, [networkNodes, customWalls, autoRoam, isHandulating, addLog]);

  // Tạo khóa dependencies theo dõi tọa độ và kết nối của trạm để cập nhật RSSI trực tiếp khi di chuyển
  const clientCoordsKey = React.useMemo(() => {
    return (Object.values(clientNodes) as ClientNode[])
      .map(c => `${c.id}:${c.x},${c.y}:${c.connectionType}:${c.wiredTo}:${c.support80211k}:${c.support80211v}:${c.support80211r}`)
      .join(';');
  }, [clientNodes]);

  // Chạy cập nhật sóng thời gian thực
  useEffect(() => {
    updateNetworkState();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [networkNodes, customWalls, autoRoam, clientCoordsKey]);

  // --- THÊM / XÓA THIẾT BỊ ---
  const handleAddDevice = (type: DeviceType) => {
    const id = 'DEV_' + Date.now();
    let name = '';
    let icon: 'Server' | 'Layers' | 'Wifi' | 'RouterIcon' = 'Wifi';
    let colorTheme: 'sky' | 'emerald' | 'slate' | 'purple' = 'purple';
    let hasWifi = true;
    const defaultSpecs = { txPower: 20, gain: 3 };
    let mode: 'router' | 'bridge' = 'bridge';
    let ssid = 'KTCN_WiFi';
    let ports = 8;
    let isMeshEnabled = false;
    let meshRole: 'controller' | 'agent' = 'agent';
    let isPoe = false;

    let wanIpMode: 'dhcp' | 'static' = 'dhcp';
    let wanIp = '';
    let lanIp = '';
    let bridgeIpMode: 'dhcp' | 'static' = 'dhcp';
    let bridgeIp = '';

    switch (type) {
      case 'isp_modem':
        name = 'ISP Modem';
        icon = 'Server';
        colorTheme = 'sky';
        hasWifi = true;
        defaultSpecs.txPower = 18;
        mode = 'router';
        ssid = 'KTCN_NhaMang_5G';
        wanIpMode = 'static';
        wanIp = '14.225.2.11';
        lanIp = '192.168.1.1';
        break;
      case 'router_wifi':
        name = 'Router WiFi';
        icon = 'RouterIcon';
        colorTheme = 'emerald';
        hasWifi = true;
        mode = 'router';
        ssid = 'KTCN_Router_L3';
        wanIpMode = 'dhcp';
        lanIp = '192.168.10.1';
        break;
      case 'switch':
        name = 'Switch LAN';
        icon = 'Layers';
        colorTheme = 'slate';
        hasWifi = false;
        defaultSpecs.txPower = 0;
        defaultSpecs.gain = 0;
        mode = 'bridge';
        ports = 8;
        isPoe = false;
        break;
      case 'ap':
        name = 'Access Point AP';
        icon = 'Wifi';
        colorTheme = 'purple';
        hasWifi = true;
        defaultSpecs.txPower = 20;
        defaultSpecs.gain = 4;
        mode = 'bridge';
        isMeshEnabled = true;
        meshRole = 'agent';
        break;
    }

    const newNode: NetworkNode = {
      id,
      type,
      name,
      icon,
      colorTheme,
      x: 35 + Math.random() * 20,
      y: 35 + Math.random() * 20,
      hasWifi,
      specs: defaultSpecs,
      mode,
      ssid,
      ports,
      isMeshEnabled,
      meshRole,
      uplinkId: 'none',
      uplinkType: 'wired',
      isPoe,
      wanIpMode,
      wanIp,
      lanIp,
      bridgeIpMode,
      bridgeIp
    };

    setNetworkNodes(prev => ({ ...prev, [id]: newNode }));
    addLog('Địa bàn mạng', `Đã lắp thêm thiết bị ${name} thành công.`, 'info');
  };

  const handleAddClient = (clientType: 'phone' | 'fpt_box' | 'fpt_camera' = 'phone') => {
    const id = 'CLI_' + Date.now();
    let name = '';
    
    if (clientType === 'phone') {
      name = 'Smartphone Cá nhân ' + (Object.keys(clientNodes).length + 1);
    } else if (clientType === 'fpt_box') {
      name = 'FPT Play Box (TV) ' + (Object.keys(clientNodes).length + 1);
    } else if (clientType === 'fpt_camera') {
      name = 'FPT Camera IQ ' + (Object.keys(clientNodes).length + 1);
    }

    const newClient: ClientNode = {
      id,
      name,
      type: 'client',
      clientType,
      connectionType: 'wifi',
      wiredTo: null,
      x: 40 + Math.random() * 15,
      y: 40 + Math.random() * 15,
      connectedTo: null,
      forceConnect: 'auto',
      currentRssi: MIN_RSSI,
      rssiMap: {},
      ipMode: 'dhcp',
      ipAddress: '192.168.1.50',
      support80211k: true,
      support80211v: true,
      support80211r: true
    };

    setClientNodes(prev => ({ ...prev, [id]: newClient }));
    addLog('Gia nhập Client', `Thiết bị máy trạm ${name} đã sẵn sàng kết nối.`, 'info');
  };

  // --- XOÁ TOÀN BỘ TOPOLOGY ---
  const handleClearAll = () => {
    setConfirmAction({
      title: 'Xóa sạch mạng Topology',
      message: 'Bạn có chắc chắn muốn xóa sạch toàn bộ bản đồ, thiết bị mạng, trạm client và dữ liệu nhật ký không? Thao tác này không thể hoàn tác.',
      btnText: 'Xóa sạch tất cả',
      btnColor: 'bg-rose-600 hover:bg-rose-500',
      onConfirm: () => {
        setNetworkNodes({});
        setClientNodes({});
        setCustomWalls([]);
        setLogs([]);
        addLog('Đã dọn dẹp', 'Bản đồ đã được dọn sạch về trạng thái rỗng.', 'warning');
      }
    });
  };

  // --- EXPORT & IMPORT ---
  const handleExportProject = () => {
    const projectData = {
      networkNodes,
      clientNodes,
      walls: customWalls,
      deviceTemplates
    };
    exportToJson(projectData, 'topology_project');
    addLog('System', 'Đã xuất dữ liệu dự án thành công', 'success');
  };

  const handleImportProject = () => {
    importFromJson((data: any) => {
      let imported = false;
      if (data.networkNodes) { setNetworkNodes(data.networkNodes); imported = true; }
      if (data.clientNodes) { setClientNodes(data.clientNodes); imported = true; }
      if (data.walls) { setCustomWalls(data.walls); imported = true; }
      if (data.deviceTemplates) { setDeviceTemplates(data.deviceTemplates); imported = true; }
      
      if (imported) {
        addLog('System', 'Đã nhập dữ liệu dự án thành công', 'success');
      } else {
        addLog('System', 'File không chứa dữ liệu dự án hợp lệ', 'error');
      }
    });
  };

  const handleSyncLibrary = async () => {
    addLog('Hệ thống', 'Đang đồng bộ thư viện...', 'info');
    try {
      let dataStr = '';
      
      try {
        const res = await fetch('/api/fetch-drive');
        if (res.ok) {
          dataStr = await res.text();
        }
      } catch (err) {
        // Log silently
      }

      if (!dataStr) {
        // Fallback for Vercel static deployment using a public CORS proxy
        const driveUrl = "https://drive.google.com/uc?export=download&id=1V3M3kcg-ZDGmNK_TwzOx_9AzviWyumxI";
        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(driveUrl)}`;
        const proxyRes = await fetch(proxyUrl);
        if (!proxyRes.ok) throw new Error('CORS Proxy fetch failed');
        const proxyData = await proxyRes.json();
        dataStr = proxyData.contents;
      }
      
      if (!dataStr) {
        throw new Error('Dữ liệu tải về trống');
      }

      const parsedData = JSON.parse(dataStr);
      let imported = false;
      if (parsedData.networkNodes) { setNetworkNodes(parsedData.networkNodes); imported = true; }
      if (parsedData.clientNodes) { setClientNodes(parsedData.clientNodes); imported = true; }
      if (parsedData.walls) { setCustomWalls(parsedData.walls); imported = true; }
      if (parsedData.deviceTemplates) { setDeviceTemplates(parsedData.deviceTemplates); imported = true; }
      
      if (imported) {
        addLog('Hệ thống', 'Đồng bộ thư viện thành công!', 'success');
      } else {
        addLog('Hệ thống', 'Dữ liệu đồng bộ không hợp lệ', 'error');
      }
    } catch (error) {
      console.error(error);
      addLog('Lỗi', `Đồng bộ thất bại: ${error}`, 'error');
    }
  };

  const handleExportIcons = () => {
    exportToJson(deviceTemplates, 'topology_icons');
    addLog('System', 'Đã xuất thư viện icon thành công', 'success');
  };

  const handleImportIcons = () => {
    importFromJson((data: any) => {
      if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && 'category' in data[0]) {
        setDeviceTemplates(prev => {
          const existingIds = new Set(prev.map(t => t.id));
          const newTemplates = data.filter(t => !existingIds.has(t.id));
          return [...prev, ...newTemplates];
        });
        addLog('System', `Đã nhập và thêm icon mới vào thư viện`, 'success');
      } else {
        addLog('System', 'File icon không hợp lệ', 'error');
      }
    });
  };

  // --- DRAG & DROP COORDS ---
  const handleMouseDownNode = (e: React.MouseEvent | React.TouchEvent, id: string) => {
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    setDraggingNodeId(id);
  };

  const handleMouseMoveRoot = (e: React.MouseEvent | React.TouchEvent) => {
    let clientX = 0;
    let clientY = 0;
    if ('touches' in e) {
      if (e.touches.length === 0) return;
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    // XỬ LÝ PAN CANVAS (Kéo toàn bộ bản đồ)
    if (isCanvasPanning && canvasRef.current) {
      const dx = clientX - panStartRef.current.x;
      const dy = clientY - panStartRef.current.y;
      setPan({ x: dx, y: dy });
      return;
    }

    // XỬ LÝ KÉO THẢ NODE/CLIENT
    if (draggingNodeId && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const lx = clientX - rect.left;
      const ly = clientY - rect.top;
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const rx = (lx - cx - pan.x) / zoom + cx;
      const ry = (ly - cy - pan.y) / zoom + cy;
      let xPercent = (rx / rect.width) * 100;
      let yPercent = (ry / rect.height) * 100;

      xPercent = Math.max(0, Math.min(xPercent, 100));
      yPercent = Math.max(0, Math.min(yPercent, 100));

      if (draggingNodeId.startsWith('CLI_')) {
        setClientNodes(prev => ({
          ...prev,
          [draggingNodeId]: { ...prev[draggingNodeId], x: xPercent, y: yPercent }
        }));
      } else {
        setNetworkNodes(prev => ({
          ...prev,
          [draggingNodeId]: { ...prev[draggingNodeId], x: xPercent, y: yPercent }
        }));
      }
      return;
    }

    // XỬ LÝ VẼ TƯỜNG TRỰC TIẾP TRÊN MẶT BẰNG
    if (editorLayout === 'custom' && isDrawingStep2 && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const lx = clientX - rect.left;
      const ly = clientY - rect.top;
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const rx = (lx - cx - pan.x) / zoom + cx;
      const ry = (ly - cy - pan.y) / zoom + cy;
      let xPercent = (rx / rect.width) * 100;
      let yPercent = (ry / rect.height) * 100;

      xPercent = Math.max(0, Math.min(xPercent, 100));
      yPercent = Math.max(0, Math.min(yPercent, 100));

      if (selectedTool === 'line') {
        const thickness = wallThicknessScale;
        let dx = xPercent - drawStart.x;
        let dy = yPercent - drawStart.y;
        
        let lengthTarget = parseFloat(fixedDimLength);
        if (!isNaN(lengthTarget) && lengthTarget > 0) {
           const L_pct = (lengthTarget / canvasScale) * 100;
           // If mostly horizontal path, snap horizontal. Wait, it's easier to force absolute direction.
           if (Math.abs(dx) > Math.abs(dy)) {
             dx = dx > 0 ? L_pct : -L_pct; // force horizontal dimension
           } else {
             const L_pct_h = (lengthTarget / canvasHeightMeters) * 100; // use height ratio
             dy = dy > 0 ? L_pct_h : -L_pct_h; // force vertical dimension
           }
        }
        
        if (Math.abs(dx) > Math.abs(dy)) {
          setPreviewWall({
            x: Math.min(drawStart.x, drawStart.x + dx),
            y: drawStart.y - thickness / 2,
            w: Math.abs(dx),
            h: thickness,
            type: selectedMaterial
          });
        } else {
          setPreviewWall({
            x: drawStart.x - thickness / 2,
            y: Math.min(drawStart.y, drawStart.y + dy),
            w: thickness,
            h: Math.abs(dy),
            type: selectedMaterial
          });
        }
      } else if (selectedTool === 'rect') {
        let w_pct = Math.abs(xPercent - drawStart.x);
        let h_pct = Math.abs(yPercent - drawStart.y);
        
        let targetW = parseFloat(fixedDimRectW);
        if (!isNaN(targetW) && targetW > 0) w_pct = (targetW / canvasScale) * 100;
        
        let targetH = parseFloat(fixedDimRectH);
        if (!isNaN(targetH) && targetH > 0) h_pct = (targetH / canvasHeightMeters) * 100;

        setPreviewWall({
          x: Math.min(drawStart.x, xPercent > drawStart.x ? drawStart.x + w_pct : drawStart.x - w_pct),
          y: Math.min(drawStart.y, yPercent > drawStart.y ? drawStart.y + h_pct : drawStart.y - h_pct),
          w: w_pct,
          h: h_pct,
          type: selectedMaterial
        });
      }
    }
  };

  const handleMouseUpRoot = (e: React.MouseEvent | React.TouchEvent) => {
    if (draggingNodeId) {
      setDraggingNodeId(null);
    }
    if (isCanvasPanning) {
      setIsCanvasPanning(false);
    }
  };

  // Click vào Canvas để tạo bắt đầu vẽ tường hoặc tắt chọn
  const handleCanvasClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.pointer-events-auto') || draggingNodeId) return;

    if (editorLayout === 'custom' && (selectedTool === 'line' || selectedTool === 'rect') && canvasRef.current) {
      const rect = canvasRef.current.getBoundingClientRect();
      const lx = e.clientX - rect.left;
      const ly = e.clientY - rect.top;
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const rx = (lx - cx - pan.x) / zoom + cx;
      const ry = (ly - cy - pan.y) / zoom + cy;
      const xPercent = (rx / rect.width) * 100;
      const yPercent = (ry / rect.height) * 100;

      if (!isDrawingStep2) {
        setIsDrawingStep2(true);
        setDrawStart({ x: xPercent, y: yPercent });
      } else {
        setIsDrawingStep2(false);
        if (previewWall && (previewWall.w > 0.5 || previewWall.h > 0.5)) {
          const nextGroupId = currentDrawGroupId.current++;
          if (selectedTool === 'line') {
            setCustomWalls(prev => [
              ...prev,
              { ...previewWall, groupId: nextGroupId }
            ]);
          } else if (selectedTool === 'rect') {
            const thickness = wallThicknessScale;
            // Tạo 4 cạnh bao của dầm hình vuông
            setCustomWalls(prev => [
              ...prev,
              { x: previewWall.x, y: previewWall.y, w: previewWall.w, h: thickness, type: selectedMaterial, groupId: nextGroupId },
              { x: previewWall.x, y: previewWall.y + previewWall.h - thickness, w: previewWall.w, h: thickness, type: selectedMaterial, groupId: nextGroupId },
              { x: previewWall.x, y: previewWall.y + thickness, w: thickness, h: previewWall.h - 2 * thickness, type: selectedMaterial, groupId: nextGroupId },
              { x: previewWall.x + previewWall.w - thickness, y: previewWall.y + thickness, w: thickness, h: previewWall.h - 2 * thickness, type: selectedMaterial, groupId: nextGroupId }
            ]);
          }
        }
        setPreviewWall(null);
      }
    }
  };

  // --- XÓA TƯỜNG (CỤC TẨY) ---
  const handleEraserClickWall = (e: React.MouseEvent, wallIdx: number, groupId: number) => {
    if (selectedTool === 'eraser' && editorLayout === 'custom') {
      e.stopPropagation();
      setCustomWalls(prev => prev.filter(w => w.groupId !== groupId));
      addLog('Xóa vật cản', 'Đã loại bỏ bức tường cách âm/chặn sóng.', 'info');
    }
  };

  // --- ROAMING THỦ CÔNG (KÍCH HOẠT PHÂN TÍCH) ---
  const handleManualRoamToggle = () => {
    const clients = Object.values(clientNodes) as ClientNode[];
    if (clients.length === 0 || isHandulating) return;

    const cli = clients[0];
    if (!cli.connectedTo) {
      addLog('Yêu cầu roaming', 'Điện thoại hiện tại không kết nối với bất kỳ Wi-Fi nào, không thể roaming.', 'warning');
      return;
    }

    const currentAp = networkNodes[cli.connectedTo];
    let bestApId: string | null = null;
    let maxRssiValue = -Infinity;

    (Object.values(networkNodes) as NetworkNode[]).forEach(dev => {
      if (dev.hasWifi && dev.id !== cli.connectedTo && cli.rssiMap[dev.id] > maxRssiValue) {
        maxRssiValue = cli.rssiMap[dev.id];
        bestApId = dev.id;
      }
    });

    if (!bestApId || maxRssiValue < DISCONNECT_RSSI) {
      addLog(
        'Đạt tối ưu',
        `Sóng hiện tại từ ${currentAp?.name} đang là sự lựa chọn tốt nhất. Không phát hiện trạm phụ nào tốt hơn.`,
        'success'
      );
      return;
    }

    const targetAp = networkNodes[bestApId];
    const ctrl1 = getControllerId(cli.connectedTo, networkNodes);
    const ctrl2 = getControllerId(bestApId, networkNodes);
    const isMesh = currentAp?.isMeshEnabled && targetAp?.isMeshEnabled && ctrl1 && ctrl2 && ctrl1 === ctrl2;

    setIsHandulating(true);
    setAutoRoam(false); // Buộc khóa auto roam tạm thời để biểu thị
    addLog(
      'Kích hoạt roaming',
      `Đang điều hướng roaming cưỡng bức từ ${currentAp?.name} (${cli.currentRssi}dBm) -> ${targetAp?.name} (${maxRssiValue}dBm). Vui lòng đợi cấu hình...`,
      'info'
    );

    setTimeout(() => {
      setClientNodes(prev => {
        if (!prev[cli.id] || !bestApId) return prev;
        return {
          ...prev,
          [cli.id]: {
            ...prev[cli.id],
            connectedTo: bestApId,
            currentRssi: maxRssiValue
          }
        };
      });

      if (isMesh) {
        const controllerNode = ctrl1 ? networkNodes[ctrl1] : null;
        addLog(
          'Roaming (Mesh)',
          `Phối hợp Controller [${controllerNode?.name || 'Mesh'}]: ${cli.name} đã chuyển vùng sang AP ${targetAp?.name} thành công trong 15ms (Không mất gói).`,
          'success'
        );
      } else {
        addLog(
          'Chuyển mạng độc lập',
          `Quá trình ngắt mạng từ [${currentAp?.name}] để bắt SSID của [${targetAp?.name}] hoàn tất. Đứt sóng & cấp lại kết nối mất ~2200ms do không cùng Controller điều phối.`,
          'warning'
        );
      }
      setIsHandulating(false);
      setAutoRoam(true);
    }, 2000);
  };

  // --- OPEN MODAL SETTINGS ---
  const handleOpenSettings = (id: string) => {
    const isClient = id.startsWith('CLI_');
    const dev = isClient ? clientNodes[id] : networkNodes[id];
    if (!dev) return;

    setSelectedNodeId(id);

    if (isClient) {
      const client = dev as ClientNode;
      setModalData({
        name: client.name,
        mode: 'bridge',
        wanIpMode: 'dhcp',
        wanIp: '',
        lanIp: '',
        bridgeIpMode: 'dhcp',
        bridgeIp: '',
        ssid: '',
        ports: 0,
        isMeshEnabled: false,
        meshRole: 'agent',
        uplinkId: 'none',
        uplinkType: 'wired',
        isPoe: false,
        txPower: 0,
        gain: 0,
        forceConnect: client.forceConnect,
        ipMode: client.ipMode,
        ipAddress: client.ipAddress,
        hasWifi: false,
        clientType: client.clientType || 'phone',
        connectionType: client.connectionType || 'wifi',
        wiredTo: client.wiredTo || 'none',
        support80211k: client.support80211k === undefined ? true : client.support80211k,
        support80211v: client.support80211v === undefined ? true : client.support80211v,
        support80211r: client.support80211r === undefined ? true : client.support80211r,
        customImage: client.customImage || '',
        hideLabel: client.hideLabel || false
      });
    } else {
      const node = dev as NetworkNode;
      setModalData({
        name: node.name,
        mode: node.mode,
        wanIpMode: node.wanIpMode,
        wanIp: node.wanIp,
        lanIp: node.lanIp,
        bridgeIpMode: node.bridgeIpMode,
        bridgeIp: node.bridgeIp,
        ssid: node.ssid,
        ports: node.ports,
        isMeshEnabled: node.isMeshEnabled,
        meshRole: node.meshRole,
        uplinkId: node.uplinkId,
        uplinkType: node.uplinkType,
        isPoe: node.isPoe,
        txPower: node.specs.txPower,
        gain: node.specs.gain,
        forceConnect: 'auto',
        ipMode: 'dhcp',
        ipAddress: '',
        hasWifi: node.hasWifi,
        customImage: node.customImage || '',
        hideLabel: node.hideLabel || false
      });
    }
  };

  const handleSaveModal = () => {
    if (!selectedNodeId || !modalData) return;

    const isClient = selectedNodeId.startsWith('CLI_');

    if (isClient) {
      setClientNodes(prev => ({
        ...prev,
        [selectedNodeId]: {
          ...prev[selectedNodeId],
          name: modalData.name,
          forceConnect: modalData.forceConnect,
          ipMode: modalData.ipMode,
          ipAddress: modalData.ipAddress,
          clientType: modalData.clientType,
          connectionType: modalData.connectionType,
          wiredTo: modalData.wiredTo === 'none' ? null : modalData.wiredTo,
          connectedTo: modalData.connectionType === 'wired' ? null : (modalData.forceConnect === 'auto' ? prev[selectedNodeId].connectedTo : modalData.forceConnect),
          support80211k: modalData.support80211k,
          support80211v: modalData.support80211v,
          support80211r: modalData.support80211r,
          customImage: modalData.customImage,
          hideLabel: modalData.hideLabel
        }
      }));
      addLog('Cập nhật Client', `Đã lưu cấu hình IP/Kết nối cho trạm ${modalData.name}`, 'info');
    } else {
      setNetworkNodes(prev => {
        const next = { ...prev };
        next[selectedNodeId] = {
          ...next[selectedNodeId],
          name: modalData.name,
          mode: modalData.mode,
          wanIpMode: modalData.wanIpMode,
          wanIp: modalData.wanIp,
          lanIp: modalData.lanIp,
          bridgeIpMode: modalData.bridgeIpMode,
          bridgeIp: modalData.bridgeIp,
          ssid: modalData.ssid,
          ports: modalData.ports,
          isMeshEnabled: modalData.isMeshEnabled,
          meshRole: modalData.meshRole,
          uplinkId: modalData.uplinkId,
          uplinkType: modalData.uplinkType,
          isPoe: modalData.isPoe,
          hasWifi: modalData.hasWifi,
          customImage: modalData.customImage,
          hideLabel: modalData.hideLabel,
          specs: {
            txPower: modalData.txPower,
            gain: modalData.gain
          }
        };

        // Đồng bộ SSID xuống các Agent nếu đây là Controller
        if (modalData.isMeshEnabled && modalData.meshRole === 'controller') {
          const visited = new Set<string>();
          const syncSsidToAgents = (parentId: string) => {
            if (visited.has(parentId)) return;
            visited.add(parentId);
            Object.keys(next).forEach((k) => {
              const childNode = next[k];
              if (
                childNode.isMeshEnabled &&
                childNode.meshRole === 'agent' &&
                childNode.uplinkId === parentId
              ) {
                next[k] = { ...childNode, ssid: modalData.ssid };
                syncSsidToAgents(k); // Đệ quy cho các trạm Mesh phụ nối tiếp
              }
            });
          };
          syncSsidToAgents(selectedNodeId);
        }

        return next;
      });
      addLog('Cập nhật Thiết bị', `Đã lưu cấu hình mạng/SSID đầy đủ cho ${modalData.name}`, 'info');
    }

    setSelectedNodeId(null);
    setModalData(null);
  };

  const handleDeleteNode = (id: string) => {
    const isClient = id.startsWith('CLI_');
    const nodeName = isClient ? clientNodes[id]?.name : networkNodes[id]?.name;

    setConfirmAction({
      title: 'Gỡ bỏ thiết bị',
      message: `Bạn có chắc chắn muốn gỡ bỏ thiết bị "${nodeName || 'này'}" khỏi hệ thống bản đồ mạng quy hoạch?`,
      btnText: 'Gỡ thiết bị',
      btnColor: 'bg-rose-600 hover:bg-rose-500',
      onConfirm: () => {
        if (isClient) {
          setClientNodes(prev => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
        } else {
          setNetworkNodes(prev => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          // Reset uplink liên quan
          setNetworkNodes(prev => {
            const next = { ...prev };
            Object.keys(next).forEach(k => {
              if (next[k].uplinkId === id) {
                next[k] = { ...next[k], uplinkId: 'none' };
              }
            });
            return next;
          });
          // Reset liên kết client liên kết tới AP bị xóa
          setClientNodes(prev => {
            const next = { ...prev };
            Object.keys(next).forEach(k => {
              if (next[k].connectedTo === id) {
                next[k] = { ...next[k], connectedTo: null };
              }
              if (next[k].forceConnect === id) {
                next[k] = { ...next[k], forceConnect: 'auto' };
              }
            });
            return next;
          });
        }
        setSelectedNodeId(null);
        setModalData(null);
        addLog('Gỡ thiết bị', `Đã dỡ bỏ thiết bị mạng "${nodeName || ''}" khỏi không gian mô phỏng.`, 'warning');
      }
    });
  };

  // --- LỰA CHỌN MẶT BẰNG MẪU ---
  const handleLayoutTemplateChange = (layout: 'none' | 'custom') => {
    setEditorLayout(layout);
    if (layout === 'none') {
      setCustomWalls([]);
      setSelectedTool('pan');
    } else {
      setCustomWalls(defaultWalls);
      setSelectedTool('line');
    }
  };

  const getThemeColors = (theme: 'sky' | 'emerald' | 'slate' | 'purple') => {
    const themes = {
      sky: { text: 'text-sky-400', border: 'border-sky-400', hex: '#38bdf8', bg: 'bg-sky-500/20' },
      emerald: { text: 'text-emerald-400', border: 'border-emerald-400', hex: '#10b981', bg: 'bg-emerald-500/20' },
      slate: { text: 'text-slate-300', border: 'border-slate-500', hex: '#94a3b8', bg: 'bg-slate-505/20' },
      purple: { text: 'text-purple-400', border: 'border-purple-400', hex: '#c084fc', bg: 'bg-purple-500/20' }
    };
    return themes[theme] || themes.slate;
  };

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (loginId.toUpperCase() === 'KTCN' && loginPass === 'KTCNPRO') {
      setIsAuthenticated(true);
      setLoginError(false);
    } else {
      setLoginError(true);
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-[#02050e] flex items-center justify-center p-4">
        <form onSubmit={handleLogin} className="bg-slate-900 border border-slate-800 p-8 rounded-xl shadow-2xl max-w-sm w-full">
          <div className="mb-8 text-center flex flex-col items-center justify-center">
            <div className="w-16 h-16 bg-sky-500/20 text-sky-400 rounded-full flex items-center justify-center mb-4">
              <Lock className="w-8 h-8" />
            </div>
            <h1 className="text-2xl font-bold text-slate-200">Truy Cập Hệ Thống</h1>
            <p className="text-slate-400 text-sm mt-2">Vui lòng nhập ID và Mật khẩu để bắt đầu</p>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-slate-400 text-xs font-bold mb-1.5 uppercase tracking-wider">ID Đăng Nhập</label>
              <input
                type="text"
                value={loginId}
                onChange={(e) => setLoginId(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded outline-none px-4 py-2 text-slate-200 focus:border-sky-500 transition-colors"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-slate-400 text-xs font-bold mb-1.5 uppercase tracking-wider">Mật Khẩu</label>
              <input
                type="password"
                value={loginPass}
                onChange={(e) => setLoginPass(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded outline-none px-4 py-2 text-slate-200 focus:border-sky-500 transition-colors"
              />
            </div>
            
            {loginError && (
              <div className="text-rose-400 text-sm text-center font-medium bg-rose-500/10 py-2 rounded">
                ID hoặc Mật khẩu không chính xác!
              </div>
            )}

            <button
              type="submit"
              className="w-full bg-sky-600 hover:bg-sky-500 text-white font-bold py-2.5 rounded transition-colors mt-2"
            >
              Đăng Nhập
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen p-4 flex flex-col items-center select-none overflow-hidden"
      onMouseMove={handleMouseMoveRoot}
      onTouchMove={handleMouseMoveRoot}
      onMouseUp={handleMouseUpRoot}
      onTouchEnd={handleMouseUpRoot}
    >
      {/* 1. Header */}
      <div className="w-full max-w-[1400px] mb-3 flex flex-col md:flex-row justify-between items-start md:items-center gap-2">
        <div>
          <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-sky-400 via-indigo-400 to-emerald-400">
            KTCN Wi-Fi Network & Roaming Simulation
          </h1>
          <p className="text-slate-400 text-xs mt-0.5">
            Mô phỏng mạng Layer 3 - Topology - Định dạng IP DHCP - Chuyển vùng Seamless Roaming (Mesh)
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={handleImportProject}
            className="px-3 py-1.5 bg-emerald-955/40 text-emerald-300 hover:bg-emerald-900 border border-emerald-800 text-xs rounded transition flex items-center gap-1 font-semibold cursor-pointer"
            title="Tải lên file dự án (.json)"
          >
            <FolderOpen className="w-3.5 h-3.5" /> Mở Dự Án
          </button>
          <button
            onClick={handleSyncLibrary}
            className="px-3 py-1.5 bg-amber-955/40 text-amber-300 hover:bg-amber-900 border border-amber-800 text-xs rounded transition flex items-center gap-1 font-semibold cursor-pointer"
            title="Đồng bộ thư viện từ Google Drive"
          >
            <CloudDownload className="w-3.5 h-3.5" /> Đồng Bộ Thư Viện
          </button>
          <button
            onClick={handleExportProject}
            className="px-3 py-1.5 bg-sky-955/40 text-sky-300 hover:bg-sky-900 border border-sky-800 text-xs rounded transition flex items-center gap-1 font-semibold cursor-pointer"
            title="Lưu lại cấu hình dự án hiện tại"
          >
            <Save className="w-3.5 h-3.5" /> Lưu Dự Án
          </button>
          <button
            onClick={() => exportToPdf('canvas-export-wrapper', 'topology-simulation', networkNodeList, clientNodeList)}
            className="px-3 py-1.5 bg-indigo-955/40 text-indigo-300 hover:bg-indigo-900 border border-indigo-800 text-xs rounded transition flex items-center gap-1 font-semibold cursor-pointer"
            title="Xuất bản vẽ hiện trạng ra file PDF"
          >
            <Download className="w-3.5 h-3.5" /> Xuất PDF
          </button>
          <button
            onClick={handleClearAll}
            className="px-3 py-1.5 bg-rose-955/40 text-rose-300 hover:bg-rose-900 border border-rose-800 text-xs rounded transition flex items-center gap-1 font-semibold cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" /> Xóa sạch Topology
          </button>
        </div>
      </div>

      {/* 2. Main Interface Layout */}
      <div className="w-full max-w-[1400px] flex gap-4 relative">
        {/* Sidebar điều chỉnh bên trái */}
        <div className="relative flex shrink-0 z-40">
          <div
            id="sidebar"
            className={`${
              isSidebarOpen ? 'w-64' : 'w-0 overflow-hidden opacity-0 pointer-events-none'
            } flex flex-col gap-3 transition-all duration-300 pr-1 max-h-[820px] overflow-y-auto custom-scrollbar`}
          >
            {/* Module 1: Thêm Thiết Bị */}
            <div className="bg-slate-900/90 border border-slate-800 rounded-lg shadow-lg">
              <div className="px-3 py-2 border-b border-slate-800 font-bold text-xs text-sky-400 flex items-center gap-1.5 uppercase tracking-wider">
                <Database className="w-3.5 h-3.5 text-sky-400 animate-pulse" /> Kho Thiết Bị KTCN
              </div>
              <div className="p-2 flex flex-col gap-1.5">
                <button
                  onClick={() => handleAddDevice('isp_modem')}
                  className="w-full bg-slate-800 hover:bg-slate-750 border border-slate-700 text-slate-200 py-1.5 rounded text-[11px] font-semibold transition flex items-center gap-2 px-2.5 cursor-pointer"
                >
                  <Server className="w-4 h-4 text-sky-400" /> Modem / Gateway Router
                </button>
                <button
                  onClick={() => handleAddDevice('router_wifi')}
                  className="w-full bg-slate-800 hover:bg-slate-755 border border-slate-700 text-slate-200 py-1.5 rounded text-[11px] font-semibold transition flex items-center gap-2 px-2.5 cursor-pointer"
                >
                  <RouterIcon className="w-4 h-4 text-emerald-400" /> Router WiFi nhánh
                </button>
                <button
                  onClick={() => handleAddDevice('switch')}
                  className="w-full bg-slate-800 hover:bg-slate-755 border border-slate-700 text-slate-200 py-1.5 rounded text-[11px] font-semibold transition flex items-center gap-2 px-2.5 cursor-pointer"
                >
                  <Layers className="w-4 h-4 text-slate-400" /> Switch LAN trung chuyển
                </button>
                <button
                  onClick={() => handleAddDevice('ap')}
                  className="w-full bg-slate-800 hover:bg-slate-755 border border-slate-700 text-slate-200 py-1.5 rounded text-[11px] font-semibold transition flex items-center gap-2 px-2.5 cursor-pointer"
                >
                  <Wifi className="w-4 h-4 text-purple-400" /> Access Point (Phát Sóng)
                </button>

                <div className="h-[1px] bg-slate-800 my-1.5"></div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[9px] uppercase tracking-wider font-bold text-slate-400 px-1">Gia nhập Client đầu cuối</span>
                  <button
                    onClick={() => handleAddClient('phone')}
                    className="w-full bg-indigo-950/40 hover:bg-indigo-950/80 text-indigo-300 border border-indigo-900/60 py-1.5 rounded text-[11px] font-semibold transition flex items-center gap-2 px-2.5 cursor-pointer"
                  >
                    <Smartphone className="w-3.5 h-3.5 text-indigo-400" /> Thêm Smartphone Cá Nhân
                  </button>
                  <button
                    onClick={() => handleAddClient('fpt_box')}
                    className="w-full bg-indigo-950/40 hover:bg-indigo-950/80 text-indigo-300 border border-indigo-900/60 py-1.5 rounded text-[11px] font-semibold transition flex items-center gap-2 px-2.5 cursor-pointer"
                  >
                    <Tv className="w-3.5 h-3.5 text-sky-450" /> Thêm FPT Play Box (TV)
                  </button>
                  <button
                    onClick={() => handleAddClient('fpt_camera')}
                    className="w-full bg-indigo-950/40 hover:bg-indigo-950/80 text-indigo-300 border border-indigo-900/60 py-1.5 rounded text-[11px] font-semibold transition flex items-center gap-2 px-2.5 cursor-pointer"
                  >
                    <Camera className="w-3.5 h-3.5 text-emerald-400" /> Thêm FPT Camera IQ
                  </button>
                </div>
              </div>
            </div>

            {/* Module 2: Môi trường / Tường phản cản */}
            <div className="bg-slate-900/90 border border-slate-800 rounded-lg shadow-lg">
              <div
                onClick={() => setIsSidebarEnvOpen(!isSidebarEnvOpen)}
                className="px-3 py-2 border-b border-slate-800 font-bold text-xs text-amber-400 flex justify-between items-center cursor-pointer hover:bg-slate-800/40 select-none uppercase tracking-wider"
              >
                <span className="flex items-center gap-1.5">
                  <Database className="w-3.5 h-3.5 text-amber-500" /> Mặt Bằng & Vẽ Tường
                </span>
                {isSidebarEnvOpen ? <ChevronUp className="w-3 h-3 text-slate-500" /> : <ChevronDown className="w-3 h-3 text-slate-500" />}
              </div>

              {isSidebarEnvOpen && (
                <div className="p-2 flex flex-col gap-2">
                  {/* Lựa chọn mặt bằng mẫu */}
                  <div className="grid grid-cols-2 gap-1 text-[10px]">
                    <button
                      onClick={() => handleLayoutTemplateChange('none')}
                      className={`py-1 rounded border font-semibold transition cursor-pointer ${
                        editorLayout === 'none'
                          ? 'bg-blue-600 border-blue-500 text-white'
                          : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-750'
                      }`}
                    >
                      Bản đồ Trống
                    </button>
                    <button
                      onClick={() => handleLayoutTemplateChange('custom')}
                      className={`py-1 rounded border font-semibold transition cursor-pointer ${
                        editorLayout === 'custom'
                          ? 'bg-amber-600 border-amber-500 text-white'
                          : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-750'
                      }`}
                    >
                      Bản vẽ Tường
                    </button>
                  </div>

                  {editorLayout === 'custom' && (
                    <div className="flex flex-col gap-2 pt-1 border-t border-slate-802">
                      {/* Công cụ vẽ */}
                      <label className="text-[9px] font-bold text-slate-500 uppercase">Công Cụ Vẽ Vật Cản</label>
                      <div className="grid grid-cols-4 gap-1 text-[9px]">
                        <button
                          onClick={() => {
                            setSelectedTool('pan');
                            setIsDrawingStep2(false);
                            setPreviewWall(null);
                          }}
                          className={`py-1 rounded border transition flex flex-col items-center justify-center gap-0.5 cursor-pointer ${
                            selectedTool === 'pan' ? 'bg-slate-700 border-slate-500 text-white font-bold' : 'bg-slate-800 border-slate-700/60 text-slate-400 hover:bg-slate-750'
                          }`}
                        >
                          <Hand className="w-3 h-3" /> Kéo
                        </button>
                        <button
                          onClick={() => {
                            setSelectedTool('line');
                            setIsDrawingStep2(false);
                            setPreviewWall(null);
                          }}
                          className={`py-1 rounded border transition flex flex-col items-center justify-center gap-0.5 cursor-pointer ${
                            selectedTool === 'line' ? 'bg-indigo-950 text-indigo-300 border-indigo-650 font-bold shadow' : 'bg-slate-800 border-slate-700/60 text-slate-400 hover:bg-slate-750'
                          }`}
                        >
                          <div className="w-4 h-0.5 bg-current my-1"></div> Đường
                        </button>
                        <button
                          onClick={() => {
                            setSelectedTool('rect');
                            setIsDrawingStep2(false);
                            setPreviewWall(null);
                          }}
                          className={`py-1 rounded border transition flex flex-col items-center justify-center gap-0.5 cursor-pointer ${
                            selectedTool === 'rect' ? 'bg-purple-955 text-purple-300 border-purple-650 font-bold shadow' : 'bg-slate-800 border-slate-700/60 text-slate-400 hover:bg-slate-750'
                          }`}
                        >
                          <div className="w-3.5 h-3.5 border-2 border-current rounded-sm"></div> Khung
                        </button>
                        <button
                          onClick={() => {
                            setSelectedTool('eraser');
                            setIsDrawingStep2(false);
                            setPreviewWall(null);
                          }}
                          className={`py-1 rounded border transition flex flex-col items-center justify-center gap-0.5 cursor-pointer ${
                            selectedTool === 'eraser' ? 'bg-rose-955 text-rose-300 border-rose-650 font-bold shadow' : 'bg-slate-800 border-slate-700/60 text-slate-400 hover:bg-slate-750'
                          }`}
                        >
                          <Trash2 className="w-3 h-3" /> Xóa
                        </button>
                      </div>

                       {/* Tùy chỉnh hiển thị  */}
                       <div className="mt-2 border-t border-slate-700/50 pt-2">
                         <label className="text-[9px] font-bold text-slate-500 uppercase flex justify-between">
                           <span>Kích thước bản đồ</span>
                           <span className="text-sky-400">{canvasScale}m</span>
                         </label>
                         <input type="range" min="10" max="300" value={canvasScale} onChange={(e) => setCanvasScale(Number(e.target.value))} className="w-full accent-sky-500 h-1.5 mt-1 cursor-ew-resize" />
                         
                         <label className="text-[9px] font-bold text-slate-500 uppercase flex justify-between mt-2">
                           <span>Thu phóng biểu tượng</span>
                           <span className="text-emerald-400">{iconScale}px</span>
                         </label>
                         <input type="range" min="16" max="100" value={iconScale} onChange={(e) => setIconScale(Number(e.target.value))} className="w-full accent-emerald-500 h-1.5 mt-1 cursor-ew-resize" />

                         <label className="text-[9px] font-bold text-slate-500 uppercase flex justify-between mt-2">
                           <span>Độ dày nét tường (%)</span>
                           <span className="text-purple-400">{wallThicknessScale}%</span>
                         </label>
                         <input type="range" min="0.1" max="5" step="0.1" value={wallThicknessScale} onChange={(e) => setWallThicknessScale(Number(e.target.value))} className="w-full accent-purple-500 h-1.5 mt-1 cursor-ew-resize" />
                       </div>

                      {/* Vật liệu tường chặn sóng */}
                      {(selectedTool === 'line' || selectedTool === 'rect') && (
                        <>
                          <label className="text-[9px] font-bold text-slate-500 uppercase mt-2">Chọn Vật Liệu Chặn Sóng</label>
                          <div className="flex flex-col gap-1 mt-1">
                            <button
                              onClick={() => setSelectedMaterial('brick')}
                              className={`px-2 py-1 rounded text-[10px] border flex justify-between items-center transition cursor-pointer ${
                                selectedMaterial === 'brick' ? 'bg-red-955/60 border-red-500 text-red-200 font-bold shadow' : 'bg-slate-800 border-slate-700/60 text-slate-400'
                              }`}
                            >
                              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-red-800 rounded"></span> Tường Gạch</span>
                              <span>-8 dBm</span>
                            </button>
                            <button
                              onClick={() => setSelectedMaterial('concrete')}
                              className={`px-2 py-1 rounded text-[10px] border flex justify-between items-center transition cursor-pointer ${
                                selectedMaterial === 'concrete' ? 'bg-slate-700 border-slate-500 text-slate-200 font-bold shadow' : 'bg-slate-800 border-slate-700/60 text-slate-400'
                              }`}
                            >
                              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-slate-500 rounded"></span> Bê Tông Cốt Thép</span>
                              <span>-15 dBm</span>
                            </button>
                            <button
                              onClick={() => setSelectedMaterial('glass')}
                              className={`px-2 py-1 rounded text-[10px] border flex justify-between items-center transition cursor-pointer ${
                                selectedMaterial === 'glass' ? 'bg-cyan-955/60 border-cyan-500 text-cyan-200 font-bold shadow' : 'bg-slate-800 border-slate-700/60 text-slate-400'
                              }`}
                            >
                              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 bg-cyan-700 border border-cyan-400 rounded-sm"></span> Vách Kính</span>
                              <span>-2 dBm</span>
                            </button>
                          </div>

                          {/* Khung kích thước cố định */}
                          <div className="mt-2 border-t border-slate-700/50 pt-2">
                             <label className="text-[9px] font-bold text-slate-500 uppercase">Kích thước tĩnh</label>
                             {selectedTool === 'line' ? (
                               <div className="flex bg-slate-900 border border-slate-700 rounded overflow-hidden mt-1 px-2 py-1 items-center">
                                 <input 
                                   type="number" 
                                   placeholder="Dài (m)" 
                                   className="bg-transparent text-xs text-white outline-none w-full"
                                   value={fixedDimLength}
                                   onChange={(e) => setFixedDimLength(e.target.value)}
                                 />
                               </div>
                             ) : (
                               <div className="flex gap-1 mt-1">
                                 <div className="flex bg-slate-900 border border-slate-700 rounded overflow-hidden px-2 py-1 items-center">
                                   <input 
                                     type="number" 
                                     placeholder="Ngang (m)" 
                                     className="bg-transparent text-xs text-white outline-none w-full"
                                     value={fixedDimRectW}
                                     onChange={(e) => setFixedDimRectW(e.target.value)}
                                   />
                                 </div>
                                 <div className="flex bg-slate-900 border border-slate-700 rounded overflow-hidden px-2 py-1 items-center">
                                   <input 
                                     type="number" 
                                     placeholder="Dọc (m)" 
                                     className="bg-transparent text-xs text-white outline-none w-full"
                                     value={fixedDimRectH}
                                     onChange={(e) => setFixedDimRectH(e.target.value)}
                                   />
                                 </div>
                               </div>
                             )}
                             <div className="text-[9px] text-slate-500 mt-1 italic leading-tight">
                               Nhập số để vẽ đường cố định 1 chiều chính xác. Để trống để kéo tự do. <br/>
                               <b>Phím Tắt: </b> Nhấn <b>ESC</b> để phím hủy, <b>CTRL+Z</b> hoàn tác.
                             </div>
                           </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Module 3: Mô Phỏng Roaming & Sự Kiện */}
            <div className="bg-slate-900/90 border border-slate-800 rounded-lg shadow-lg flex-grow flex flex-col min-h-[250px]">
              <div
                onClick={() => setIsSidebarRoamOpen(!isSidebarRoamOpen)}
                className="px-3 py-2 border-b border-slate-805 font-bold text-xs text-emerald-400 flex justify-between items-center cursor-pointer hover:bg-slate-800/40 select-none uppercase tracking-wider"
              >
                <span className="flex items-center gap-1.5">
                  <Play className="w-3.5 h-3.5" /> Giả lập Roaming
                </span>
                {isSidebarRoamOpen ? <ChevronUp className="w-3 h-3 text-slate-500" /> : <ChevronDown className="w-3 h-3 text-slate-500" />}
              </div>

              {isSidebarRoamOpen && (
                <div className="p-2 flex flex-col flex-grow gap-2 min-h-0">
                  {/* Nút Auto Roam Toggle */}
                  <div className="flex items-center justify-between bg-slate-950/60 px-2 py-1.5 rounded border border-slate-800">
                    <span className="text-[10px] font-bold text-slate-300">Tự Động Roaming</span>
                    <button
                      onClick={() => setAutoRoam(!autoRoam)}
                      className="w-9 h-5 rounded-full transition-colors relative flex items-center bg-slate-700 cursor-pointer"
                      style={{ backgroundColor: autoRoam ? '#10b981' : '#475569' }}
                    >
                      <span
                        className="w-3.5 h-3.5 bg-white rounded-full shadow absolute transition-transform"
                        style={{ transform: autoRoam ? 'translateX(18px)' : 'translateX(4px)' }}
                      />
                    </button>
                  </div>

                  {/* Nút Manual Roam */}
                  <button
                    onClick={handleManualRoamToggle}
                    disabled={isHandulating}
                    className="w-full bg-indigo-650 hover:bg-indigo-600 disabled:opacity-50 text-white font-bold py-2 rounded text-[11px] transition flex justify-center items-center gap-1.5 shadow cursor-pointer animate-pulse"
                  >
                    {isHandulating ? (
                      <span className="inline-block animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-white"></span>
                    ) : (
                      <Wifi className="w-3.5 h-3.5 text-indigo-300" />
                    )}
                    {isHandulating ? 'Đang Chuyển Vùng...' : 'Yêu Cầu Roaming Lập Tức'}
                  </button>

                  <div className="h-[1px] bg-slate-800 my-1"></div>

                  {/* Phần logs hạt nhân */}
                  <div className="flex justify-between items-center">
                    <span className="text-[9px] text-slate-500 font-bold uppercase">Nhật Ký Chuyển Vùng</span>
                    <button
                      onClick={() => setLogs([])}
                      className="text-[9px] text-rose-450 hover:text-rose-300 font-bold uppercase flex items-center gap-0.5 transition cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" /> Xóa
                    </button>
                  </div>

                  <div className="flex-grow overflow-y-auto custom-scrollbar flex flex-col gap-1.5 max-h-[220px] min-h-[120px] select-text">
                    {logs.length === 0 ? (
                      <div className="text-[10px] italic text-slate-500 text-center py-6">
                        Không có sự kiện mạng nào gần đây...
                      </div>
                    ) : (
                      logs.map(log => {
                        const types = {
                          success: 'text-emerald-300 border-emerald-900 bg-emerald-950/20',
                          warning: 'text-amber-305 border-amber-900 bg-amber-955/20',
                          error: 'text-rose-300 border-rose-900 bg-rose-955/20',
                          info: 'text-slate-300 border-slate-800 bg-slate-900/40'
                        };
                        return (
                          <div
                            key={log.id}
                            className={`p-1.5 border rounded text-[10px] leading-relaxed transition ${types[log.type]}`}
                          >
                            <div className="flex justify-between items-center mb-0.5 border-b border-white/5 pb-0.5">
                              <span className="font-bold flex items-center gap-1">
                                {log.type === 'error' && <AlertTriangle className="w-2.5 h-2.5" />}
                                {log.title}
                              </span>
                              <span className="text-[8px] opacity-40">{log.timestamp}</span>
                            </div>
                            <div className="opacity-90">{log.desc}</div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Drawer trigger toggle button */}
          <button
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="absolute left-full top-4 z-50 bg-slate-900 hover:bg-slate-800 border-y border-r border-slate-800 w-6 h-10 rounded-r flex items-center justify-center text-slate-400 transition cursor-pointer"
          >
            {isSidebarOpen ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
        </div>

        {/* 3. SIMULATION CANVAS AREA */}
        <div className="flex-grow flex flex-col min-w-0">
          <div
            id="sim-canvas"
            ref={canvasRef}
            onClick={handleCanvasClick}
            className={`w-full aspect-[16/9] mx-auto bg-[#02050e] rounded-xl overflow-hidden border border-slate-850 relative ${
              selectedTool === 'pan' ? 'cursor-grab' : selectedTool === 'eraser' ? 'cursor-alias' : 'cursor-crosshair'
            }`}
          >
            {/* Thanh công cụ zoom góc phải */}
            <div className="absolute top-4 right-4 z-40 bg-slate-900/95 backdrop-blur-md p-1 border border-slate-805 rounded-lg flex flex-col gap-1 shadow-lg pointer-events-auto">
              <button
                onClick={() => setZoom(z => Math.min(2, z + 0.1))}
                className="w-7 h-7 bg-slate-850 hover:bg-sky-500 rounded flex items-center justify-center text-slate-300 transition cursor-pointer"
                title="Bóng bẩy phóng to"
              >
                <Plus className="w-4 h-4" />
              </button>
              <button
                onClick={() => {
                  setZoom(1);
                  setPan({ x: 0, y: 0 });
                }}
                className="w-7 h-7 bg-slate-850 hover:bg-sky-550 rounded flex items-center justify-center text-[10px] text-slate-300 font-bold transition cursor-pointer"
                title="Trả về 1x"
              >
                1x
              </button>
              <button
                onClick={() => setZoom(z => Math.max(0.5, z - 0.1))}
                className="w-7 h-7 bg-slate-855 hover:bg-sky-500 rounded flex items-center justify-center text-slate-300 transition cursor-pointer"
                title="Thu nhỏ không gian"
              >
                <Minus className="w-4 h-4" />
              </button>
            </div>

            {/* Backdrop Zooming & Panning Wrapper */}
            <div
              id="canvas-export-wrapper"
              className="absolute inset-0 origin-center transition-transform duration-75"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`
              }}
              onMouseDown={(e) => {
                if (selectedTool === 'pan' && !(e.target as HTMLElement).closest('.pointer-events-auto')) {
                  setIsCanvasPanning(true);
                  panStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
                }
              }}
            >
              {/* Grid hình dạng nền mờ ảo */}
              <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.015)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.015)_1px,transparent_1px)] bg-[size:25px_25px] opacity-100 pointer-events-none"></div>

              {/* Kích thước cạnh nhà */}
              <div className="absolute top-0 right-0 w-full flex items-start justify-center pointer-events-none z-10">
                <span className="bg-[#02050e] text-slate-400 border border-slate-800 rounded-b font-mono font-bold text-[9px] px-2 py-0.5 shadow-sm">Ngang: {canvasScale.toFixed(1)}m</span>
              </div>
              <div className="absolute top-1/2 left-0 flex items-center justify-start pointer-events-none z-10 -translate-y-1/2 -rotate-90 origin-left translate-x-3.5">
                <span className="bg-[#02050e] text-slate-400 border border-slate-800 rounded-b font-mono font-bold text-[9px] px-2 py-0.5 shadow-sm whitespace-nowrap">Dọc: {canvasHeightMeters.toFixed(1)}m</span>
              </div>

              {/* LAYER 1: Sóng Phủ Coverage (AP Wi-Fi) */}
              <div id="coverage-layer" className="absolute inset-0 pointer-events-none opacity-65">
                {networkNodeList.map(dev => {
                  if (!dev.hasWifi) return null;
                  const maxLoss = dev.specs.txPower + dev.specs.gain + 85;
                  const logDist = (maxLoss - 46) / 30;
                  const maxDistMet = Math.pow(10, logDist);

                  const col = getThemeColors(dev.colorTheme);
                  const widthPercentage = (maxDistMet / canvasScale) * 100 * 2;
                  const heightPercentage = (maxDistMet / canvasHeightMeters) * 100 * 2;

                  return (
                    <div
                      key={`cov-${dev.id}`}
                      className="absolute rounded-full -translate-x-1/2 -translate-y-1/2 select-none pulse-coverage"
                      style={{
                        left: `${dev.x}%`,
                        top: `${dev.y}%`,
                        width: `${widthPercentage}%`,
                        height: `${heightPercentage}%`,
                        background: `radial-gradient(circle, ${col.hex}2b 0%, ${col.hex}0f 65%, transparent 100%)`,
                        border: `2px dashed ${col.hex}50`
                      }}
                    />
                  );
                })}
              </div>

              {/* LAYER 2: Tường Phản Kháng Chắn Sóng */}
              <div id="walls-container" className="absolute inset-0 z-10 pointer-events-none">
                {customWalls.map((w, idx) => {
                  const materialsClass = {
                    brick: 'wall-brick border border-red-900',
                    concrete: 'wall-concrete border border-slate-750',
                    glass: 'wall-glass'
                  };
                  return (
                    <div
                      key={`wall-${idx}`}
                      onClick={(e) => handleEraserClickWall(e, idx, w.groupId)}
                      className={`absolute ${materialsClass[w.type]} ${
                        selectedTool === 'eraser' ? 'hover:brightness-150 hover:scale-[1.01] pointer-events-auto cursor-pointer border-red-500' : ''
                      }`}
                      style={{
                        left: `${w.x}%`,
                        top: `${w.y}%`,
                        width: `${w.w}%`,
                        height: `${w.h}%`
                      }}
                      title={`${w.type === 'brick' ? 'Tường Gạch (-8dB)' : w.type === 'concrete' ? 'Bê tông (-15dB)' : 'Vách kính (-2dB)'}. ${
                        selectedTool === 'eraser' ? 'Click để xóa!' : ''
                      }`}
                    />
                  );
                })}

                {/* Khung xem trước khi vẽ tường */}
                {previewWall && (
                  <div
                    className="absolute wall-preview pointer-events-none border-2 border-dashed border-amber-500 bg-amber-500/20 flex items-center justify-center"
                    style={{
                      left: `${previewWall.x}%`,
                      top: `${previewWall.y}%`,
                      width: `${previewWall.w}%`,
                      height: `${previewWall.h}%`
                    }}
                  >
                    <div className="absolute -top-6 bg-amber-900/90 text-amber-100 px-1.5 py-0.5 rounded text-[10px] font-bold whitespace-nowrap shadow-md">
                      {selectedTool === 'line' 
                         ? `${calculateDistanceMeters(0, 0, previewWall.w, previewWall.h, canvasScale).toFixed(1)}m` 
                         : `${(previewWall.w * canvasScale / 100).toFixed(1)}m x ${(previewWall.h * canvasHeightMeters / 100).toFixed(1)}m`
                      }
                    </div>
                  </div>
                )}
              </div>

              {/* LAYER 3: ĐƯỜNG LIÊN KẾT WIRELESS / WIRED BACKHAUL & WIFI TRUY VẾT SVG */}
              <div className="absolute inset-0 pointer-events-none z-5">
                <svg className="absolute inset-0 w-full h-full" style={{ overflow: 'visible' }}>
                  {/* Vẽ đường truyền tải Cáp (Wired Backhaul) / Mesh Link (Wireless Backhaul) giữa AP */}
                  {networkNodeList.map(dev => {
                    if (dev.uplinkId === 'none' || !networkNodes[dev.uplinkId]) return null;
                    const parent = networkNodes[dev.uplinkId] as NetworkNode;

                    if (dev.uplinkType === 'wired') {
                      return (
                        <g key={`backhaul-${dev.id}`}>
                          <line
                            x1={`${parent.x}%`}
                            y1={`${parent.y}%`}
                            x2={`${dev.x}%`}
                            y2={`${dev.y}%`}
                            stroke="#3b82f6"
                            strokeWidth="3.5"
                            strokeLinecap="round"
                            opacity="0.8"
                            className="wired-connection-line-active"
                            style={{ filter: 'drop-shadow(0px 0px 3px rgba(59, 130, 246, 0.4))' }}
                          />
                        </g>
                      );
                    } else {
                      const mx = (parent.x + dev.x) / 2;
                      const my = (parent.y + dev.y) / 2;
                      const distMeters = calculateDistanceMeters(dev.x, dev.y, parent.x, parent.y, canvasScale);
                      const wallAtten = getWallAttenuation(dev.x, dev.y, parent.x, parent.y, customWalls);
                      const mRssi = Math.max(
                        MIN_RSSI,
                        calculateRealRssi(distMeters, parent.specs.txPower, parent.specs.gain) - wallAtten
                      );

                      let signalCol = '#34d399'; // Xanh lá
                      if (mRssi < -78) signalCol = '#f43f5e'; // Đỏ yếu
                      else if (mRssi < -68) signalCol = '#fbbf24'; // Vàng vừa

                      return (
                        <g key={`backhaul-${dev.id}`}>
                          <line
                            x1={`${parent.x}%`}
                            y1={`${parent.y}%`}
                            x2={`${dev.x}%`}
                            y2={`${dev.y}%`}
                            stroke="#10b981"
                            strokeWidth="2.5"
                            strokeDasharray="6,6"
                            strokeLinecap="round"
                            className="wifi-connection-line-active"
                            opacity="0.9"
                            style={{
                              filter: 'drop-shadow(0px 0px 4px rgba(16, 185, 129, 0.5))'
                            }}
                          />
                          {/* Nhãn RSSI sắc nét ở trung điểm liên kết Mesh Wireless */}
                          <text
                            x={`${mx}%`}
                            y={`${my}%`}
                            textAnchor="middle"
                            dominantBaseline="central"
                            fill={signalCol}
                            fontSize="9px"
                            fontFamily="monospace"
                            fontWeight="bold"
                            paintOrder="stroke"
                            stroke="#020617"
                            strokeWidth="3.5"
                            style={{ userSelect: 'none' }}
                          >
                            {mRssi} dBm
                          </text>
                        </g>
                      );
                    }
                  })}

                  {/* Vẽ đường kết nối Wi-Fi Client đối với trạm đang liên kết */}
                  {clientNodeList.map(cli => {
                    if (cli.connectionType === 'wired') return null;
                    if (!cli.connectedTo || !networkNodes[cli.connectedTo] || cli.currentRssi <= DISCONNECT_RSSI) return null;
                    const ap = networkNodes[cli.connectedTo] as NetworkNode;
                    const col = getThemeColors(ap.colorTheme);

                    return (
                      <line
                        key={`wifi-line-${cli.id}`}
                        x1={`${ap.x}%`}
                        y1={`${ap.y}%`}
                        x2={`${cli.x}%`}
                        y2={`${cli.y}%`}
                        stroke={col.hex}
                        strokeWidth="2"
                        strokeDasharray="4,6"
                        strokeLinecap="round"
                        className="wifi-connection-line-active"
                        opacity="0.75"
                        style={{
                          filter: `drop-shadow(0px 0px 3px ${col.hex}60)`
                        }}
                      />
                    );
                  })}

                  {/* Vẽ đường kết nối Cáp LAN của máy trạm (Wired Client) */}
                  {clientNodeList.map(cli => {
                    if (cli.connectionType !== 'wired' || !cli.wiredTo || !networkNodes[cli.wiredTo]) return null;
                    const dev = networkNodes[cli.wiredTo];
                    return (
                      <line
                        key={`wired-line-${cli.id}`}
                        x1={`${dev.x}%`}
                        y1={`${dev.y}%`}
                        x2={`${cli.x}%`}
                        y2={`${cli.y}%`}
                        stroke="#2563eb"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        className="wired-connection-line-active"
                        opacity="0.85"
                        style={{
                          filter: 'drop-shadow(0px 0px 3px rgba(37, 99, 235, 0.5))'
                        }}
                      />
                    );
                  })}
                </svg>
              </div>

              {/* LAYER 4: THIẾT BỊ MẠNG (NODES CONTAINER) */}
              <div id="nodes-layer" className="absolute inset-0 z-20 pointer-events-none">
                {networkNodeList.map(dev => {
                  const col = getThemeColors(dev.colorTheme);

                  const renderIcon = () => {
                    switch (dev.icon) {
                      case 'Server':
                        return <Server className={`w-[60%] h-[60%] ${col.text}`} />;
                      case 'Layers':
                        return <Layers className={`w-[60%] h-[60%] ${col.text}`} />;
                      case 'Wifi':
                        return <Wifi className={`w-[60%] h-[60%] ${col.text}`} />;
                      case 'RouterIcon':
                        return <RouterIcon className={`w-[60%] h-[60%] ${col.text}`} />;
                      default:
                        return <Wifi className={`w-[60%] h-[60%] ${col.text}`} />;
                    }
                  };

                  let subnetText = '';
                  if (dev.mode === 'router') {
                    const actualWan = dev.wanIpMode === 'dhcp' ? 'DHCP WAN' : (dev.wanIp || 'Dải WAN IP');
                    subnetText = (
                      <div className="flex flex-col items-center w-full mt-0.5 border-t border-slate-800/40 pt-0.5 text-[8px] leading-tight text-slate-400 font-mono">
                        <span className="text-sky-400 text-center truncate w-[90px]">W: {actualWan}</span>
                        <span className="text-emerald-400">L: {dev.lanIp || 'Chưa định LAN'}</span>
                      </div>
                    );
                  } else {
                    const actualIp = dev.bridgeIpMode === 'dhcp' ? getDHCPAddressForNode(dev) : (dev.bridgeIp || '191.168.1.20');
                    subnetText = (
                      <div className="text-[8.5px] text-slate-400 font-mono mt-0.5">
                        IP: {actualIp}
                      </div>
                    );
                  }

                  let detailSsidBadge = '';
                  if (dev.hasWifi) {
                    if (dev.isMeshEnabled) {
                      let meshRssiText = '';
                      if (dev.meshRole === 'agent' && dev.uplinkId !== 'none' && dev.uplinkType === 'wireless') {
                        const pNode = networkNodes[dev.uplinkId];
                        if (pNode) {
                          const distMeters = calculateDistanceMeters(dev.x, dev.y, pNode.x, pNode.y, canvasScale);
                          const wallAtten = getWallAttenuation(dev.x, dev.y, pNode.x, pNode.y, customWalls);
                          const mRssi = Math.max(
                            MIN_RSSI,
                            calculateRealRssi(distMeters, pNode.specs.txPower, pNode.specs.gain) - wallAtten
                          );
                          meshRssiText = ` (${mRssi} dBm)`;
                        }
                      }

                      const ctrlId = getControllerId(dev.id, networkNodes);
                      const ctrlNode = ctrlId ? networkNodes[ctrlId] : null;

                      detailSsidBadge = (
                        <div className="mt-1 flex flex-col items-center gap-0.5">
                          {dev.meshRole === 'controller' ? (
                            <span className="bg-indigo-900/40 text-indigo-300 font-bold px-1 py-0.5 rounded text-[8px] border border-indigo-700/60 leading-none">
                              Mesh CTRL
                            </span>
                          ) : (
                            <span className="bg-slate-800/80 text-emerald-400 font-bold px-1 py-0.5 rounded text-[8px] border border-emerald-900/60 leading-none">
                              Mesh AGENT{meshRssiText}
                            </span>
                          )}
                          <span className="text-[8px] text-slate-350 max-w-[85px] truncate mt-0.5" title={dev.ssid}>
                            SSID: {dev.ssid}
                          </span>
                          <span className="text-[7.5px] text-violet-400 font-bold truncate max-w-[85px]" title={ctrlNode ? `Thuộc Controller: ${ctrlNode.name}` : 'Chưa có Controller quản lý'}>
                            {ctrlNode ? `• ${ctrlNode.name.replace(/^(Modem|Router|Switch|AP|Ceiling|Ceiling Access Point|FPT|FPT Optical|FPT Switch)\s+/i, '')}` : '• Lẻ/Không CTRL'}
                          </span>
                        </div>
                      );
                    } else {
                      detailSsidBadge = (
                        <div className="mt-1 flex flex-col items-center">
                          <span className="bg-sky-955/40 text-sky-400 px-1 py-0.5 rounded text-[8px] border border-sky-800/50 leading-none">
                            AP AP-Mode
                          </span>
                          <span className="text-[8px] text-slate-355 max-w-[85px] truncate mt-0.5">
                            SSID: {dev.ssid}
                          </span>
                        </div>
                      );
                    }
                  } else {
                    const poeLabel = dev.isPoe ? <span className="text-amber-400 font-bold shrink-0">PoE ✓</span> : '';
                    subnetText = (
                      <div className="text-[8.5px] text-slate-400 font-mono mt-0.5 flex items-center gap-1">
                        <span>{dev.ports}P</span> {poeLabel}
                      </div>
                    );
                  }

                  return (
                    <div
                      key={dev.id}
                      className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center draggable-node pointer-events-auto select-none"
                      title="Nhấn đúp chuột trái để cấu hình"
                      style={{
                        left: `${dev.x}%`,
                        top: `${dev.y}%`
                      }}
                      onMouseDown={(e) => handleMouseDownNode(e, dev.id)}
                      onTouchStart={(e) => handleMouseDownNode(e, dev.id)}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        handleOpenSettings(dev.id);
                      }}
                    >
                      <div
                        className={`bg-slate-900 rounded-xl flex items-center justify-center border-2 ${
                          col.border
                        } shadow-[0_4px_16px_rgba(0,0,0,0.6)] z-10 relative cursor-grab active:cursor-grabbing transition-transform ${
                          draggingNodeId === dev.id ? 'scale-110 ring-1 ring-blue-500' : ''
                        }`}
                        style={{
                          width: `${iconScale}px`,
                          height: `${iconScale}px`,
                          boxShadow: draggingNodeId === dev.id ? `0 0 12px ${col.hex}70` : '0 4px 10px rgba(0,0,0,0.5)'
                        }}
                      >
                        {dev.customImage ? (
                          <img
                            src={dev.customImage}
                            alt={dev.name}
                            className="w-full h-full object-contain p-1 rounded-lg"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          renderIcon()
                        )}

                        <button
                          onClick={() => handleOpenSettings(dev.id)}
                          className="absolute -top-1.5 -right-1.5 bg-slate-800 w-4.5 h-4.5 rounded-full text-[9px] text-slate-300 hover:text-white border border-slate-705 flex items-center justify-center hover:bg-sky-600 shadow-md transition pointer-events-auto cursor-pointer"
                        >
                          <Settings className="w-2.5 h-2.5" />
                        </button>
                      </div>

                      {!dev.hideLabel && (
                        <div className="bg-slate-950/85 border border-slate-800/80 px-2 py-1 mt-1.5 rounded-md backdrop-blur-sm min-w-[100px] flex flex-col items-center shadow-lg pointer-events-auto text-center">
                          <span className="font-bold text-slate-202 text-[10px] truncate max-w-[110px]">{dev.name}</span>
                          {subnetText}
                          {detailSsidBadge}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* LAYER 5: CLIENT DEVICES (CLIENT PORT-HOLDER) */}
              <div id="clients-layer" className="absolute inset-0 z-30 pointer-events-none">
                {clientNodeList.map(cli => {
                  const connectedAp = cli.connectedTo ? networkNodes[cli.connectedTo] : null;

                  let colMode = 'text-slate-400';
                  let signalText = 'Mất sóng ✕';
                  let borderStyle = 'border-slate-500';

                  if (cli.connectionType === 'wired') {
                    const wiredParent = cli.wiredTo ? networkNodes[cli.wiredTo] : null;
                    if (wiredParent) {
                      borderStyle = 'border-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.3)] bg-blue-950/20';
                      colMode = 'text-blue-400 font-bold';
                      signalText = 'LAN: 1 Gbps';
                    } else {
                      borderStyle = 'border-rose-850 bg-rose-950/15';
                      colMode = 'text-rose-400 font-medium';
                      signalText = 'Cáp lỏng (Chưa cắm)';
                    }
                  } else if (connectedAp && cli.currentRssi > DISCONNECT_RSSI) {
                    const theme = getThemeColors(connectedAp.colorTheme);
                    borderStyle = theme.border;

                    if (cli.currentRssi > -62) {
                      colMode = 'text-emerald-400 font-bold';
                      signalText = `${cli.currentRssi} dBm (Mạnh)`;
                    } else if (cli.currentRssi > -73) {
                      colMode = 'text-amber-400 font-bold';
                      signalText = `${cli.currentRssi} dBm (Vừa)`;
                    } else {
                      colMode = 'text-rose-400 font-bold';
                      signalText = `${cli.currentRssi} dBm (Yếu)`;
                    }
                  }

                  const displayIp = cli.ipMode === 'static' ? cli.ipAddress : getDHCPAddressForClient(cli);

                  const renderClientIcon = () => {
                    if (cli.customImage) {
                      return (
                        <img
                          src={cli.customImage}
                          alt={cli.name}
                          className="w-full h-full object-contain p-1 rounded"
                          referrerPolicy="no-referrer"
                        />
                      );
                    }
                    const type = cli.clientType || 'phone';
                    if (type === 'fpt_box') {
                      return <Tv className="w-[60%] h-[60%] text-sky-400 animate-pulse" />;
                    } else if (type === 'fpt_camera') {
                      return <Camera className="w-[60%] h-[60%] text-emerald-400" />;
                    }
                    return <Smartphone className="w-[60%] h-[60%] text-slate-350" />;
                  };

                  return (
                    <div
                      key={cli.id}
                      className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center draggable-node pointer-events-auto select-none"
                      title="Nhấn đúp chuột trái để cấu hình"
                      style={{
                        left: `${cli.x}%`,
                        top: `${cli.y}%`
                      }}
                      onMouseDown={(e) => handleMouseDownNode(e, cli.id)}
                      onTouchStart={(e) => handleMouseDownNode(e, cli.id)}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        handleOpenSettings(cli.id);
                      }}
                    >
                      <div
                        className={`bg-slate-900 rounded-md flex items-center justify-center border-2 ${borderStyle} shadow-lg cursor-grab active:cursor-grabbing relative transition-transform ${
                          draggingNodeId === cli.id ? 'scale-115' : ''
                        }`}
                        style={{
                          width: `${iconScale}px`,
                          height: `${iconScale}px`,
                          boxShadow: cli.connectionType !== 'wired' && connectedAp && cli.currentRssi > DISCONNECT_RSSI ? `0 0 8px ${getThemeColors(connectedAp.colorTheme).hex}40` : ''
                        }}
                      >
                        {renderClientIcon()}

                        <button
                          onClick={() => handleOpenSettings(cli.id)}
                          className="absolute -top-1.5 -right-1.5 bg-slate-800 border border-slate-700 w-4 h-4 rounded-full text-[8px] text-slate-350 hover:text-white flex items-center justify-center hover:bg-sky-600 shadow transition pointer-events-auto cursor-pointer"
                        >
                          <Settings className="w-2.5 h-2.5" />
                        </button>
                      </div>

                      {!cli.hideLabel && (
                        <div className="bg-slate-950/90 border border-slate-805 px-1.5 py-0.5 mt-1 rounded backdrop-blur-sm min-w-[70px] text-center flex flex-col items-center shadow-md">
                          <span className="text-[10px] text-slate-300 font-semibold truncate max-w-[85px] leading-tight">
                            {cli.name}
                          </span>
                          <span className={`text-[9.5px] ${colMode} leading-tight mt-0.5`}>{signalText}</span>
                          <span className="text-[8px] text-slate-500 font-mono tracking-tighter leading-none mt-0.5 truncate w-[75px]" title={displayIp}>
                            {displayIp}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 4. MODAL DIALOG CẤU HÌNH IP CHUYÊN SÂU */}
      {selectedNodeId && modalData && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-[999] flex justify-center items-center pointer-events-auto animate-fade-in p-4 select-text">
          <div className="bg-slate-900 border border-slate-800 rounded-xl shadow-2xl w-[440px] max-w-full overflow-hidden flex flex-col max-h-[90vh]">
            {/* Header Modal */}
            <div className="px-4 py-3 bg-slate-900 border-b border-slate-800 flex justify-between items-center shrink-0">
              <h3 className="font-bold text-sm text-sky-400 uppercase tracking-wide flex items-center gap-2">
                <Settings className="w-4 h-4" /> Cài đặt thiết bị {selectedNodeId.startsWith('CLI_') ? 'Máy trạm' : 'Hạ tầng'}
              </h3>
              <button
                type="button"
                onClick={() => {
                  setSelectedNodeId(null);
                  setModalData(null);
                }}
                className="text-slate-400 hover:text-white transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Khung nhập liệu Scrollable */}
            <div className="p-4 flex flex-col gap-3.5 overflow-y-auto custom-scrollbar text-xs">
              <div>
                <label className="block text-slate-400 font-bold mb-1 uppercase tracking-wider text-[9px]">Tên Thiết Bị / Model</label>
                <input
                  type="text"
                  value={modalData.name}
                  onChange={(e) => setModalData({ ...modalData, name: e.target.value })}
                  className="w-full bg-slate-850 border border-slate-700/80 rounded px-3 py-1.5 text-white outline-none focus:border-sky-500 font-medium mb-3"
                />
                <label className="flex items-center justify-between bg-slate-900 border border-slate-700/50 rounded px-3 py-2 cursor-pointer shadow-sm hover:border-slate-600 transition">
                  <span className="text-[10px] font-bold text-slate-300">Chỉ hiển thị Icon (Tắt/Ẩn thẻ thông số trên bản vẽ)</span>
                  <input
                    type="checkbox"
                    checked={!!modalData.hideLabel}
                    onChange={(e) => setModalData({ ...modalData, hideLabel: e.target.checked })}
                    className="rounded border-slate-700 text-sky-500 focus:ring-sky-500 bg-slate-950 w-3.5 h-3.5 cursor-pointer"
                  />
                </label>
              </div>

              {/* THƯ VIỆN THIẾT BỊ TỰ ĐỊNH NGHĨA (ĐÃ LƯU & CÓ THỂ SỬ DỤNG CHO CÁC LẦN TIẾP THEO) */}
              <div className="bg-slate-900/60 border border-slate-800 p-3 rounded-lg flex flex-col gap-2.5">
                <div className="flex justify-between items-center pb-1.5 border-b border-slate-850">
                  <h4 className="text-amber-500 font-bold text-[10px] uppercase flex items-center gap-1.5">
                    <ImageIcon className="w-3.5 h-3.5 text-amber-500" /> Thư viện thiết bị
                  </h4>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={handleImportIcons}
                      className="text-[9px] bg-slate-800 hover:bg-emerald-900 border border-slate-700 px-1.5 py-0.5 rounded transition cursor-pointer text-slate-300 flex items-center gap-1"
                      title="Nhập thư viện icon"
                    >
                      <FolderOpen className="w-3 h-3" /> Nhập
                    </button>
                    <button
                      type="button"
                      onClick={handleExportIcons}
                      className="text-[9px] bg-slate-800 hover:bg-sky-900 border border-slate-700 px-1.5 py-0.5 rounded transition cursor-pointer text-slate-300 flex items-center gap-1"
                      title="Xuất thư viện icon"
                    >
                      <Save className="w-3 h-3" /> Xuất
                    </button>
                    {modalData.customImage && (
                      <button
                        type="button"
                        onClick={() => setModalData({ ...modalData, customImage: '' })}
                        className="text-[9px] bg-slate-800 hover:bg-rose-950 hover:text-rose-450 border border-slate-700 px-1.5 py-0.5 rounded transition cursor-pointer text-slate-400 animate-fade-in"
                      >
                        Xóa
                      </button>
                    )}
                  </div>
                </div>

                {/* Preview hình ảnh thiết bị đang được chọn */}
                <div className="flex items-center gap-3 bg-slate-950/45 p-2 rounded border border-slate-850">
                  <div className="w-12 h-12 bg-slate-900 border border-slate-805 rounded-lg flex items-center justify-center shrink-0 shadow-inner">
                    {modalData.customImage ? (
                      <img
                        src={modalData.customImage}
                        alt="Preview"
                        className="w-10 h-10 object-contain rounded"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <div className="text-[10px] text-slate-500 font-medium text-center">Auto</div>
                    )}
                  </div>
                  <div className="flex flex-col gap-0.5 overflow-hidden">
                    <span className="text-[10px] font-bold text-slate-300 truncate">
                      {modalData.customImage ? 'Đang áp dụng ảnh tùy chỉnh' : 'Đang dùng icon mặc định'}
                    </span>
                    <span className="text-[9px] text-slate-450 truncate" title={modalData.customImage || 'Hạ tầng vẽ mô phỏng'}>
                      {modalData.customImage ? (modalData.customImage.startsWith('data:') ? 'Ảnh đã lưu trong thư viện' : modalData.customImage) : 'Hạ tầng vẽ mô phỏng'}
                    </span>
                  </div>
                </div>

                {/* Các mục phân loại thiết bị: modem, router, sw, AP */}
                <div className="flex border-b border-slate-800">
                  {(['modem', 'router', 'switch', 'ap'] as const).map((tab) => {
                    const count = deviceTemplates.filter(t => t.category === tab).length;
                    return (
                      <button
                        key={tab}
                        type="button"
                        onClick={() => setIconTab(tab)}
                        className={`flex-1 text-[10px] font-bold py-1 border-b-2 text-center uppercase transition-all duration-200 cursor-pointer flex items-center justify-center gap-1 ${
                          iconTab === tab
                            ? 'border-amber-500 text-amber-400 bg-amber-500/5'
                            : 'border-transparent text-slate-450 hover:text-slate-300 hover:bg-slate-850'
                        }`}
                      >
                        <span>{tab === 'switch' ? 'SW' : tab}</span>
                        <span className="text-[8px] bg-slate-850 px-1 py-0.2 rounded-full font-mono text-slate-400">{count}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Grid danh sách các thiết bị người dùng đã lưu trong mục active */}
                <div className="grid grid-cols-3 gap-1.5 p-1 bg-slate-950/25 rounded border border-slate-850 max-h-[145px] overflow-y-auto custom-scrollbar">
                  {deviceTemplates.filter((t) => t.category === iconTab).length === 0 ? (
                    <div className="col-span-3 py-4 text-center text-slate-500 text-[9.5px] italic">
                      Chưa có mẫu nào được lưu trong kho "{iconTab.toUpperCase()}". Hãy nhập mới bên dưới để lưu lại!
                    </div>
                  ) : (
                    deviceTemplates
                      .filter((t) => t.category === iconTab)
                      .map((p) => {
                        const isSelected = modalData.customImage === p.image;
                        return (
                          <div
                            key={p.id}
                            style={{ contentVisibility: 'auto' }}
                            className={`group relative p-1.5 rounded bg-slate-900 border transition-all flex flex-col items-center gap-1 cursor-pointer hover:border-amber-500/70 ${
                              isSelected ? 'border-amber-500 ring-1 ring-amber-500/20 bg-amber-950/15' : 'border-slate-800'
                            }`}
                            onClick={() => {
                              setModalData({
                                ...modalData,
                                name: p.name,
                                customImage: p.image
                              });
                              addLog('Sử dụng mẫu', `Đã áp dụng mẫu ${p.name} từ kho để đổi hình ảnh/tên`, 'success');
                            }}
                          >
                            <img
                              src={p.image}
                              alt={p.name}
                              className="w-10 h-10 object-contain p-0.5 rounded bg-slate-950 border border-slate-850/80 group-hover:scale-105 transition"
                              referrerPolicy="no-referrer"
                            />
                            <span className="text-[7.5px] text-slate-400 font-medium text-center truncate w-full" title={p.name}>
                              {p.name}
                            </span>

                            {/* Nút xóa vĩnh viễn thiết bị khỏi thư viện lưu trữ */}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeviceTemplates(prev => prev.filter(item => item.id !== p.id));
                                addLog('Thư viện', `Đã gỡ bỏ mẫu ${p.name} khỏi kho lưu trữ`, 'warning');
                              }}
                              className="absolute top-0.5 right-0.5 bg-slate-950 hover:bg-rose-900 text-slate-400 hover:text-white rounded-full p-0.5 transition pointer-events-auto border border-slate-800"
                              title="Xóa mẫu này"
                            >
                              <X className="w-2.5 h-2.5" />
                            </button>
                          </div>
                        );
                      })
                  )}
                </div>

                {/* KHU VỰC THÊM THIẾT BỊ MỚI VÀ LƯU CHO CÁC LẦN TIẾP THEO (PERSISTENT ADDITION FORM) */}
                <div className="bg-slate-950/40 p-2.5 rounded border border-slate-800/60 flex flex-col gap-2 mt-1">
                  <div className="font-bold text-[8.5px] text-slate-400 uppercase tracking-widest flex items-center gap-1 border-b border-slate-850 pb-1">
                    <Plus className="w-3 h-3 text-amber-500" /> Thêm Mới Thiết Bị Vào Thư Viện Lâu Dài
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <div>
                      <label className="block text-slate-450 text-[8px] font-bold uppercase mb-0.5">1. Tên dòng thiết bị (Model)</label>
                      <input
                        type="text"
                        placeholder="Ví dụ: Router FPT WiFi 6 AX1800GZ"
                        value={newTemplateName}
                        onChange={(e) => setNewTemplateName(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-[10px] text-white outline-none placeholder:text-slate-600 focus:border-amber-500"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-1.5">
                      <div>
                        <label className="block text-slate-450 text-[8px] font-bold uppercase mb-0.5">2. Phân mục tủ</label>
                        <select
                          value={newTemplateCategory}
                          onChange={(e) => setNewTemplateCategory(e.target.value as any)}
                          className="w-full bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-[10px] text-slate-200 outline-none focus:border-amber-500"
                        >
                          <option value="modem">Modem / Gateway</option>
                          <option value="router">Router WiFi</option>
                          <option value="switch">Switch (SW)</option>
                          <option value="ap">Access Point (AP)</option>
                        </select>
                      </div>

                      <div className="flex flex-col justify-end">
                        <label className="block text-slate-450 text-[8px] font-bold uppercase mb-0.5">3. Tải hình ảnh lên</label>
                        <label className="bg-slate-800 hover:bg-slate-755 border border-slate-700 text-slate-200 text-[9.5px] py-1 rounded text-center cursor-pointer transition font-medium flex items-center justify-center gap-1">
                          📁 Chọn tệp ảnh
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) {
                                const reader = new FileReader();
                                reader.onloadend = () => {
                                  setNewTemplateImage(reader.result as string);
                                };
                                reader.readAsDataURL(file);
                              }
                            }}
                          />
                        </label>
                      </div>
                    </div>

                    <div>
                      <label className="block text-slate-450 text-[8px] font-bold uppercase mb-0.5">Hoặc dán URL ảnh trực tiếp</label>
                      <input
                        type="text"
                        placeholder="Dán link https://...png hoặc svg"
                        value={newTemplateImage.startsWith('data:') ? '' : newTemplateImage}
                        onChange={(e) => setNewTemplateImage(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-[10px] text-white outline-none placeholder:text-slate-600 focus:border-amber-500"
                      />
                    </div>

                    {/* Preview ảnh trước khi lưu */}
                    {newTemplateImage && (
                      <div className="flex items-center gap-2 bg-slate-900/60 p-1.5 rounded border border-slate-850 animate-fade-in">
                        <img
                          src={newTemplateImage}
                          alt="Đang chuẩn bị"
                          className="w-8 h-8 object-contain rounded"
                          referrerPolicy="no-referrer"
                        />
                        <span className="text-[8px] text-emerald-400 font-medium">✓ Ảnh sẵn sàng! Click Lưu bên dưới để hoàn tất.</span>
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={() => {
                        if (!newTemplateName.trim()) {
                          alert('Vui lòng nhập tên thiết bị / model!');
                          return;
                        }
                        if (!newTemplateImage) {
                          alert('Vui lòng tải tệp ảnh lên hoặc dán liên kết URL ảnh!');
                          return;
                        }
                        const tplId = 'user_tpl_' + Date.now();
                        const newTpl = {
                          id: tplId,
                          name: newTemplateName.trim(),
                          category: newTemplateCategory,
                          image: newTemplateImage
                        };

                        // Cập nhật thư viện
                        setDeviceTemplates((prev) => [...prev, newTpl]);

                        // Tự động áp dụng ảnh này vào thiết bị đang sửa đổi ngay lập tức
                        setModalData({
                          ...modalData,
                          name: newTemplateName.trim(),
                          customImage: newTemplateImage
                        });

                        addLog('Lưu thư viện', `Mẫu "${newTemplateName}" đã được lưu trữ vĩnh viễn và áp dụng!`, 'success');

                        // Reset form
                        setNewTemplateName('');
                        setNewTemplateImage('');
                      }}
                      className="w-full bg-amber-600 hover:bg-amber-500 border border-amber-500/50 text-white font-bold py-1 px-3 rounded text-[10px] cursor-pointer transition flex items-center justify-center gap-1 mt-0.5 shadow-md uppercase"
                    >
                      💾 Lưu thiết bị mới vào kho sử dụng mãi mãi
                    </button>
                  </div>
                </div>
              </div>

              {/* LẤY IP CHO MÁY TRẠM CLIENT */}
              {selectedNodeId.startsWith('CLI_') ? (
                <div className="flex flex-col gap-3 w-full">
                  {/* CẤU HÌNH LOẠI THIẾT BỊ VÀ THIẾT LẬP KẾT NỐI */}
                  <div className="bg-slate-900/50 p-2.5 rounded-lg border border-slate-800">
                    <h4 className="text-sky-400 font-bold text-[10px] uppercase mb-2 flex items-center gap-1 pb-1 border-b border-slate-800">
                      <Smartphone className="w-3.5 h-3.5 text-sky-400" /> Bản chất phần cứng & Vật lý
                    </h4>
                    <div className="mb-2">
                      <label className="block text-slate-400 text-[9px] font-bold mb-1 uppercase">Loại Thiết Bị</label>
                      <select
                        value={modalData.clientType}
                        onChange={(e) => setModalData({ ...modalData, clientType: e.target.value as any })}
                        className="w-full bg-slate-850 border border-slate-700 text-slate-200 py-1.5 px-2 rounded mb-2 outline-none focus:border-sky-500"
                      >
                        <option value="phone">📱 Smartphone Cá Nhân / Máy tính cầm tay</option>
                        <option value="fpt_box">📺 FPT Play Box (TV Box giải trí thông minh)</option>
                        <option value="fpt_camera">📷 FPT Camera IQ (Cam an ninh nhận diện khuôn mặt)</option>
                      </select>
                    </div>

                    <div className="mb-2">
                      <label className="block text-slate-400 text-[9px] font-bold mb-1 uppercase">Phương thức truyền dẫn</label>
                      <select
                        value={modalData.connectionType}
                        onChange={(e) => {
                          const nextConnType = e.target.value as 'wifi' | 'wired';
                          setModalData({
                            ...modalData,
                            connectionType: nextConnType,
                            forceConnect: nextConnType === 'wired' ? 'auto' : modalData.forceConnect
                          });
                        }}
                        className="w-full bg-slate-850 border border-slate-700 text-slate-200 py-1.5 px-2 rounded outline-none focus:border-sky-500"
                      >
                        <option value="wifi">📡 Kết nối mạng không dây Wi-Fi</option>
                        <option value="wired">🔌 Đi cáp LAN (Cố định, hỗ trợ đi dây mạng)</option>
                      </select>
                    </div>

                    {modalData.connectionType === 'wired' && (
                      <div className="mt-2 bg-slate-950/40 p-2 rounded border border-slate-850">
                        <label className="block text-blue-400 text-[9px] font-bold mb-1 uppercase">Cắm vào cổng hạ tầng nào?</label>
                        <select
                          value={modalData.wiredTo || 'none'}
                          onChange={(e) => setModalData({ ...modalData, wiredTo: e.target.value })}
                          className="w-full bg-slate-850 border border-slate-700 text-slate-200 py-1.5 px-2 rounded outline-none focus:border-sky-500"
                        >
                          <option value="none">-- Rút phích cáp LAN (Để trần hờ) --</option>
                          {networkNodeList.map(n => (
                            <option key={n.id} value={n.id}>
                              Cổng LAN của: {n.name} ({n.type === 'switch' ? 'Switch' : 'AP/Router'})
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>

                  <div className="bg-slate-900/50 p-2.5 rounded-lg border border-slate-800">
                    <h4 className="text-indigo-400 font-bold text-[10px] uppercase mb-2 flex items-center gap-1 pb-1 border-b border-slate-800">
                      <Smartphone className="w-3.5 h-3.5 text-indigo-400" /> Giao thức cấp mạng Client (TCP/IP)
                    </h4>
                    <div className="mb-2">
                      <label className="block text-slate-400 text-[9px] font-bold mb-1 uppercase">Phương Thức IP</label>
                      <select
                        value={modalData.ipMode}
                        onChange={(e) => setModalData({ ...modalData, ipMode: e.target.value as 'dhcp' | 'static' })}
                        className="w-full bg-slate-850 border border-slate-700 text-slate-200 py-1.5 px-2 rounded mb-2 outline-none focus:border-sky-500"
                      >
                        <option value="dhcp">DHCP (Nhận IP tự động từ Gateway chính)</option>
                        <option value="static">IP Tĩnh (Static IP cố định cấu hình tay)</option>
                      </select>
                    </div>
                    {modalData.ipMode === 'static' && (
                      <div>
                        <label className="block text-slate-400 text-[9px] font-bold mb-1 uppercase">Địa Chỉ IP Tĩnh mong muốn</label>
                        <input
                          type="text"
                          value={modalData.ipAddress}
                          onChange={(e) => setModalData({ ...modalData, ipAddress: e.target.value })}
                          placeholder="Ví dụ: 192.168.1.50"
                          className="w-full bg-slate-850 border border-slate-700 rounded px-3 py-1 text-white outline-none focus:border-sky-500"
                        />
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                /* CẤU HÌNH IP CHUYÊN SÂU CHO ROUTER VÀ SWITCH */
                <div className="bg-slate-900/50 p-2.5 rounded-lg border border-slate-800">
                  <h4 className="text-sky-400 font-bold text-[10px] uppercase mb-2 flex items-center gap-1 pb-1 border-b border-slate-800">
                    <Database className="w-3.5 h-3.5" /> Định nghĩa chức năng Gateway & IP Lan
                  </h4>

                  <div className="mb-2">
                    <label className="block text-slate-400 font-bold text-[9px] mb-1 uppercase text-slate-450">Chế Độ Hoạt Động</label>
                    <select
                      value={modalData.mode}
                      onChange={(e) => {
                        const newMode = e.target.value as 'router' | 'bridge';
                        setModalData({
                          ...modalData,
                          mode: newMode,
                          isMeshEnabled: newMode === 'bridge' ? modalData.isMeshEnabled : false
                        });
                      }}
                      className="w-full bg-slate-850 border border-slate-700 text-slate-200 py-1.5 px-2 rounded outline-none focus:border-sky-500"
                    >
                      <option value="router">Gateway Router (Cấp dải mạng riêng / DHCP Server bật)</option>
                      <option value="bridge">Switch/AP Bridge (Bám trạm tuyến trên cấp IP)</option>
                    </select>
                  </div>

                  {modalData.mode === 'router' ? (
                    <div className="flex flex-col gap-2 bg-slate-950/40 p-2 rounded border border-slate-800">
                      <div>
                        <label className="block text-slate-450 font-bold text-[8.5px] mb-1 uppercase">Mạng ngoài WAN IP</label>
                        <div className="flex gap-1.5">
                          <select
                            value={modalData.wanIpMode}
                            onChange={(e) => setModalData({ ...modalData, wanIpMode: e.target.value as 'dhcp' | 'static' })}
                            className="bg-slate-850 border border-slate-700 text-slate-200 py-1.5 px-1 rounded text-[10px] w-1/3 outline-none"
                          >
                            <option value="dhcp">DHCP WAN</option>
                            <option value="static">Static WAN</option>
                          </select>
                          <input
                            type="text"
                            value={modalData.wanIp}
                            disabled={modalData.wanIpMode === 'dhcp'}
                            placeholder="Dải IP WAN nhà mạng"
                            onChange={(e) => setModalData({ ...modalData, wanIp: e.target.value })}
                            className="bg-slate-850 border border-slate-700 rounded px-2.5 py-1 text-white outline-none w-2/3 text-[11px] disabled:opacity-40 focus:border-sky-405"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-slate-450 font-bold text-[8.5px] mb-1 uppercase">LAN Gateway IP (Subnet cấp mạng)</label>
                        <input
                          type="text"
                          value={modalData.lanIp}
                          placeholder="Ví dụ: 192.168.1.1"
                          onChange={(e) => setModalData({ ...modalData, lanIp: e.target.value })}
                          className="w-full bg-slate-850 border border-slate-700 rounded px-3 py-1 text-white outline-none text-[11px] focus:border-sky-505"
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2 bg-slate-955/40 p-2 rounded border border-slate-800">
                      <div>
                        <label className="block text-slate-455 font-bold text-[8.5px] mb-1 uppercase">Lấy IP Nội Bộ AP</label>
                        <select
                          value={modalData.bridgeIpMode}
                          onChange={(e) => setModalData({ ...modalData, bridgeIpMode: e.target.value as 'dhcp' | 'static' })}
                          className="w-full bg-slate-850 border border-slate-700 text-slate-200 py-1 px-2 rounded text-[10px] outline-none"
                        >
                          <option value="dhcp">Tự động nhận IP DHCP từ Router chính</option>
                          <option value="static">IP tĩnh quản trị (Static IP AP)</option>
                        </select>
                      </div>
                      {modalData.bridgeIpMode === 'static' && (
                        <div>
                          <label className="block text-slate-450 font-bold text-[8.5px] mb-1 uppercase">Đặt IP Quản Trị AP</label>
                          <input
                            type="text"
                            value={modalData.bridgeIp}
                            placeholder="Ví dụ: 192.168.1.250"
                            onChange={(e) => setModalData({ ...modalData, bridgeIp: e.target.value })}
                            className="w-full bg-slate-850 border border-slate-700 rounded px-3 py-1 text-white outline-none text-[11px] focus:border-sky-500"
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* LỰA CHỌN PHÁT WI-FI (MÔ PHỎNG ROUTER CÓ HỖ TRỢ WIFI HAY KHÔNG) */}
              {!selectedNodeId.startsWith('CLI_') && (
                <div className="bg-slate-900/50 p-2.5 rounded-lg border border-slate-800">
                  <h4 className="text-emerald-400 font-bold text-[10px] uppercase mb-2 flex items-center gap-1 pb-1 border-b border-slate-800">
                    <Wifi className="w-3.5 h-3.5" /> Khả năng hỗ trợ Không Dây (Wireless Radio)
                  </h4>
                  <div className="flex justify-between items-center bg-slate-950/40 px-2.5 py-2 rounded border border-slate-800">
                    <div className="flex flex-col pr-2">
                      <span className="text-[10px] font-bold text-slate-300 uppercase">Phát sóng Wi-Fi (Wi-Fi Enabled)</span>
                      <span className="text-[8.5px] text-slate-400 mt-0.5 leading-normal">
                        Bật để router phát Wi-Fi cho máy trạm roaming. Tắt để chỉ làm thiết bị dây.
                      </span>
                    </div>
                    <button
                      onClick={() => {
                        const nextHasWifi = !modalData.hasWifi;
                        setModalData({
                          ...modalData,
                          hasWifi: nextHasWifi,
                          isMeshEnabled: nextHasWifi ? modalData.isMeshEnabled : false
                        });
                      }}
                      className="w-9 h-5 rounded-full transition-colors relative flex items-center bg-slate-700 cursor-pointer shrink-0"
                      style={{ backgroundColor: modalData.hasWifi ? '#10b981' : '#475569' }}
                    >
                      <span
                        className="w-3.5 h-3.5 bg-white rounded-full shadow absolute transition-transform"
                        style={{ transform: modalData.hasWifi ? 'translateX(18px)' : 'translateX(4px)' }}
                      />
                    </button>
                  </div>
                </div>
              )}

              {/* MESH WI-FI & SSID (CHỈ DÀNH CHO THIẾT BỊ WI-FI ĐÃ BẬT PHÁT SÓNG) */}
              {!selectedNodeId.startsWith('CLI_') && modalData.hasWifi && (
                <div className="bg-slate-900/50 p-2.5 rounded-lg border border-slate-800">
                  <h4 className="text-purple-400 font-bold text-[10px] uppercase mb-2 flex items-center gap-1 pb-1 border-b border-slate-800">
                    <Wifi className="w-3.5 h-3.5 text-purple-400" /> Cấu hình sóng phát Wi-Fi Mesh
                  </h4>

                  <div className="flex justify-between items-center mb-3 bg-indigo-950/20 px-2 py-1.5 rounded border border-indigo-900/10">
                    <label className="text-[10px] font-bold text-indigo-300 uppercase">Khai Thác Wi-Fi Mesh (Seamless)</label>
                    <button
                      onClick={() => setModalData({ ...modalData, isMeshEnabled: !modalData.isMeshEnabled })}
                      className="w-9 h-5 rounded-full transition-colors relative flex items-center bg-slate-700 cursor-pointer"
                      style={{ backgroundColor: modalData.isMeshEnabled ? '#6366f1' : '#475569' }}
                    >
                      <span
                        className="w-3.5 h-3.5 bg-white rounded-full shadow absolute transition-transform"
                        style={{ transform: modalData.isMeshEnabled ? 'translateX(18px)' : 'translateX(4px)' }}
                      />
                    </button>
                  </div>

                  {modalData.isMeshEnabled ? (
                    <div className="flex flex-col gap-2 mt-1 pb-1">
                      <div>
                        <label className="block text-slate-450 font-bold text-[8.5px] uppercase mb-1">Vai Trò Sóng Mesh</label>
                        <select
                          value={modalData.meshRole}
                          onChange={(e) => {
                            const role = e.target.value as 'controller' | 'agent';
                            let newSsid = modalData.ssid;
                            if (role === 'agent' && modalData.uplinkId !== 'none') {
                              const upNode = networkNodeList.find(n => n.id === modalData.uplinkId);
                              if (upNode && upNode.ssid) {
                                newSsid = upNode.ssid;
                              }
                            }
                            setModalData({
                              ...modalData,
                              meshRole: role,
                              ssid: newSsid,
                              uplinkType: role === 'controller' ? 'wired' : modalData.uplinkType
                            });
                          }}
                          className="w-full bg-slate-850 border border-slate-700 text-slate-200 py-1.5 px-2 rounded outline-none"
                        >
                          <option value="controller">Controller (Trạm gốc điều khiển SSID)</option>
                          <option value="agent">Agent (Nhận đồng bộ sóng không dây/Mesh Agent)</option>
                        </select>
                      </div>
                      {modalData.meshRole === 'agent' ? (
                        <div className="p-1 px-2 border border-yellow-900/35 bg-yellow-950/10 text-[9px] text-yellow-300 rounded leading-normal flex items-start gap-1">
                          <Info className="w-3.5 h-3.5 text-yellow-405 shrink-0 mt-0.5" />
                          <span>Agent tự động kế thừa tên mạng SSID từ Controller và phối hợp đồng bộ để Roaming mượt.</span>
                        </div>
                      ) : (
                        <div>
                          <label className="block text-slate-450 font-bold text-[8.5px] uppercase mb-1">SSID Mesh Chung</label>
                          <input
                            type="text"
                            value={modalData.ssid}
                            onChange={(e) => setModalData({ ...modalData, ssid: e.target.value })}
                            className="w-full bg-slate-850 border border-slate-700 rounded px-2.5 py-1.5 text-white outline-none focus:border-sky-505"
                          />
                        </div>
                      )}
                    </div>
                  ) : (
                    <div>
                      <label className="block text-slate-450 font-bold text-[8.5px] uppercase mb-1">Tên WiFi độc lập (SSID)</label>
                      <input
                        type="text"
                        value={modalData.ssid}
                        placeholder="Ví dụ: WiFi_Tang_1"
                        onChange={(e) => setModalData({ ...modalData, ssid: e.target.value })}
                        className="w-full bg-slate-850 border border-slate-700 rounded px-2.5 py-1.5 text-white outline-none focus:border-sky-505"
                      />
                    </div>
                  )}

                  {/* TX POWER & ANTENNA GAIN */}
                  <div className="grid grid-cols-2 gap-3 mt-3 border-t border-slate-850 pt-2.5">
                    <div>
                      <label className="block text-slate-450 font-bold text-[8.5px] uppercase">Lực phát (Tx Power dBm)</label>
                      <input
                        type="number"
                        min="10"
                        max="30"
                        value={modalData.txPower}
                        onChange={(e) => setModalData({ ...modalData, txPower: parseInt(e.target.value) || 20 })}
                        className="w-full bg-slate-850 border border-slate-702 rounded px-2 py-1 mt-0.5 text-white text-[11px] outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-455 font-bold text-[8.5px] uppercase">Lực Anten (Gain dBi)</label>
                      <input
                        type="number"
                        min="0"
                        max="15"
                        value={modalData.gain}
                        onChange={(e) => setModalData({ ...modalData, gain: parseInt(e.target.value) || 4 })}
                        className="w-full bg-slate-855 border border-slate-702 rounded px-2 py-1 mt-0.5 text-white text-[11px] outline-none"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* CẤU HÌNH SWITCH (CHỈ DÀNH CHO SWITCH) */}
              {!selectedNodeId.startsWith('CLI_') && networkNodes[selectedNodeId]?.type === 'switch' && (
                <div className="bg-slate-900/50 p-2.5 rounded-lg border border-slate-800">
                  <h4 className="text-slate-300 font-bold text-[10px] uppercase mb-2 flex items-center gap-1 pb-1 border-b border-slate-800">
                    <Layers className="w-3.5 h-3.5 text-slate-400" /> Bản năng phần cứng Switch
                  </h4>
                  <div className="mb-2">
                    <label className="block text-slate-450 font-bold text-[8.5px] uppercase mb-1">Số Cổng Cắm (Ports)</label>
                    <select
                      value={modalData.ports}
                      onChange={(e) => setModalData({ ...modalData, ports: parseInt(e.target.value) })}
                      className="w-full bg-slate-850 border border-slate-700 text-slate-200 py-1.5 px-2 rounded text-[11px]"
                    >
                      <option value={4}>4 Ports</option>
                      <option value={8}>8 Ports (Chuẩn)</option>
                      <option value={16}>16 Ports</option>
                      <option value={24}>24 Ports</option>
                      <option value={48}>48 Ports</option>
                    </select>
                  </div>
                  <div className="flex justify-between items-center bg-slate-950/40 p-2 rounded border border-slate-800 mt-2">
                    <span className="text-[9.5px] font-bold text-slate-300 uppercase">Tải nguồn Power over Ethernet (PoE)</span>
                    <button
                      onClick={() => setModalData({ ...modalData, isPoe: !modalData.isPoe })}
                      className="w-9 h-5 rounded-full transition-colors relative flex items-center bg-slate-700 cursor-pointer"
                      style={{ backgroundColor: modalData.isPoe ? '#f59e0b' : '#475569' }}
                    >
                      <span
                        className="w-3.5 h-3.5 bg-white rounded-full shadow absolute transition-transform"
                        style={{ transform: modalData.isPoe ? 'translateX(18px)' : 'translateX(4px)' }}
                      />
                    </button>
                  </div>
                </div>
              )}

              {/* THIẾT LẬP KẾT NỐI SÓNG LƯU TRẠM MẠNG (UPLINK LINE / MESH PARENT) */}
              {!selectedNodeId.startsWith('CLI_') && (
                <div className="bg-slate-900/50 p-2.5 rounded-lg border border-slate-800">
                  <h4 className="text-blue-400 font-bold text-[10px] uppercase mb-2 flex items-center gap-1 pb-1 border-b border-slate-800">
                    <Database className="w-3.5 h-3.5 text-blue-405" /> Đường liên kết (Uplink / Backhaul)
                  </h4>
                  <div className="mb-2">
                    <label className="block text-slate-450 font-bold text-[8.5px] uppercase mb-1">Uplink Nối Lên Thiết Bị</label>
                    <select
                      value={modalData.uplinkId}
                      onChange={(e) => {
                        const upId = e.target.value;
                        const upNode = networkNodeList.find(n => n.id === upId);
                        const isAgent = modalData.meshRole === 'agent';
                        let newSsid = modalData.ssid;
                        if (isAgent && upNode && upNode.ssid) {
                          newSsid = upNode.ssid;
                        }
                        setModalData({ ...modalData, uplinkId: upId, uplinkType: upId === 'none' ? 'wired' : modalData.uplinkType, ssid: newSsid });
                      }}
                      className="w-full bg-slate-850 border border-slate-700 text-slate-200 py-1.5 px-2 rounded text-[11px] outline-none"
                    >
                      <option value="none">-- Không liên kết lên dải trung tâm --</option>
                      {networkNodeList
                        .filter(n => n.id !== selectedNodeId)
                        .map(n => (
                          <option key={n.id} value={n.id}>
                            Nối lên: {n.name}
                          </option>
                        ))}
                    </select>
                  </div>

                  {modalData.uplinkId !== 'none' && (
                    <div>
                      <label className="block text-slate-450 font-bold text-[8.5px] uppercase mb-1">Đường trung chuyển dải trung tâm</label>
                      <select
                        value={modalData.isMeshEnabled && modalData.meshRole === 'controller' ? 'wired' : modalData.uplinkType}
                        onChange={(e) => {
                          const val = e.target.value as 'wired' | 'wireless';
                          if (val === 'wireless' && modalData.isMeshEnabled && modalData.meshRole === 'controller') {
                            alert('Trạm điều khiển (Mesh Controller) không thể kết nối uplink bằng Wi-Fi không dây. Controller phải là thiết bị chính/gốc. Vui lòng chuyển vai trò thành Agent hoặc kết nối bằng cổng Cáp LAN mạng có dây!');
                            return;
                          }
                          setModalData({ ...modalData, uplinkType: val });
                        }}
                        className="w-full bg-slate-855 border border-slate-700 text-slate-202 py-1.5 px-2 rounded text-[11px] outline-none"
                      >
                        <option value="wired">Sợi LAN dây mạng (Gigabit LAN)</option>
                        {!(modalData.isMeshEnabled && modalData.meshRole === 'controller') && (
                          <option value="wireless">Mesh không dây Backhaul (Khớp 5GHz)</option>
                        )}
                      </select>
                      {modalData.isMeshEnabled && modalData.meshRole === 'controller' && (
                        <p className="text-[9px] text-amber-500 mt-1 italic leading-tight">
                          * Lưu lý thuyết Mesh: Thiết bị đóng vai trò là Mesh Controller (Trạm gốc điều khiển) không thể bắt bắc cầu (uplink) không dây từ trạm khác. Chỉ hỗ trợ liên kết LAN có dây (Wired Backhaul) hoặc không chọn uplink.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* BẮT SÓNG ĐỐI VỚI CLIENT */}
              {selectedNodeId.startsWith('CLI_') && modalData.connectionType !== 'wired' && (
                <>
                  <div className="bg-slate-900/50 p-2.5 rounded-lg border border-slate-800">
                    <h4 className="text-slate-300 font-bold text-[10px] uppercase mb-2 flex items-center gap-1 pb-1 border-b border-slate-800">
                      <Wifi className="w-3.5 h-3.5 text-slate-400" /> Khóa bám AP Sóng Wi-Fi
                    </h4>
                    <label className="block text-slate-450 font-bold text-[8.5px] uppercase mb-1">Trạm phát Wi-Fi liên quan</label>
                    <select
                      value={modalData.forceConnect}
                      onChange={(e) => setModalData({ ...modalData, forceConnect: e.target.value })}
                      className="w-full bg-slate-805 border border-slate-700 text-slate-202 py-1.5 px-2 rounded text-[11px] outline-none"
                    >
                      <option value="auto">Tự động (Auto Roaming mượt bám dải tốt nhất)</option>
                      {networkNodeList
                        .filter(n => n.hasWifi)
                        .map(n => (
                          <option key={n.id} value={n.id}>
                            Ép liên kết: {n.name}
                          </option>
                        ))}
                    </select>
                  </div>

                  {/* CẤU HÌNH CÔNG NGHỆ 802.11k/v/r ĐỐI VỚI CLIENT WIFI */}
                  <div className="bg-slate-900/50 p-2.5 rounded-lg border border-slate-800 flex flex-col gap-2">
                    <h4 className="text-amber-400 font-bold text-[10px] uppercase flex items-center gap-1 pb-1 border-b border-slate-800">
                      <Radio className="w-3.5 h-3.5 text-amber-400" /> Tính năng Roaming 802.11k/v/r
                    </h4>
                    <span className="text-[9.5px] text-slate-400 leading-relaxed mb-1 block">
                      Kích hoạt các thuật toán/tiêu chuẩn giúp tối ưu hóa tiến trình tự động nhảy sóng (steering/roaming).
                    </span>
                    <div className="flex flex-col gap-2.5">
                      <label className="flex items-start gap-2.5 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={modalData.support80211k ?? true}
                          onChange={(e) => setModalData({ ...modalData, support80211k: e.target.checked })}
                          className="mt-0.5 rounded border-slate-700 text-amber-500 focus:ring-amber-500 bg-slate-950 w-3.5 h-3.5 cursor-pointer"
                        />
                        <div>
                          <span className="text-[10px] font-bold text-slate-200 block">Tiêu chuẩn 802.11k (Neighbor Report)</span>
                          <span className="text-[9px] text-slate-450 block leading-tight">Yêu cầu AP lân cận để quét sóng nhanh cực bám, giảm độ trễ tìm điểm phát mượt mà.</span>
                        </div>
                      </label>

                      <label className="flex items-start gap-2.5 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={modalData.support80211v ?? true}
                          onChange={(e) => setModalData({ ...modalData, support80211v: e.target.checked })}
                          className="mt-0.5 rounded border-slate-700 text-amber-500 focus:ring-amber-500 bg-slate-950 w-3.5 h-3.5 cursor-pointer"
                        />
                        <div>
                          <span className="text-[10px] font-bold text-slate-200 block">Tiêu chuẩn 802.11v (BSS Transition)</span>
                          <span className="text-[9px] text-slate-450 block leading-tight">Hỗ trợ Steering từ AP chính chủ động kéo/đổi trạm kết nối khi tín hiệu sụt giảm sớm.</span>
                        </div>
                      </label>

                      <label className="flex items-start gap-2.5 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={modalData.support80211r ?? true}
                          onChange={(e) => setModalData({ ...modalData, support80211r: e.target.checked })}
                          className="mt-0.5 rounded border-slate-700 text-amber-500 focus:ring-amber-500 bg-slate-950 w-3.5 h-3.5 cursor-pointer"
                        />
                        <div>
                          <span className="text-[10px] font-bold text-slate-200 block">Tiêu chuẩn 802.11r (Fast Transition)</span>
                          <span className="text-[9px] text-slate-450 block leading-tight">Rút ngắn bắt tay xác thực WPA bảo mật để tránh rớt packet mạng (~15ms siêu nhanh).</span>
                        </div>
                      </label>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Footer Modal: Hành động */}
            <div className="px-4 py-3 bg-slate-900 border-t border-slate-800 flex justify-between items-center shrink-0">
              <button
                onClick={() => handleDeleteNode(selectedNodeId)}
                className="px-3 py-1.5 bg-rose-950/60 hover:bg-rose-900 border border-rose-800 text-rose-200 hover:text-white rounded text-xs font-bold transition flex items-center gap-1 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" /> Gỡ thiết bị
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setSelectedNodeId(null);
                    setModalData(null);
                  }}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 rounded text-xs font-bold transition cursor-pointer"
                >
                  Đóng
                </button>
                <button
                  onClick={handleSaveModal}
                  className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-xs font-bold transition shadow-lg flex items-center gap-1.5 cursor-pointer"
                >
                  <Check className="w-3.5 h-3.5" /> Lưu cấu hình
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* CUSTOM CONFIRMATION MODAL (IFRAME SAFE) */}
      {confirmAction && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[1000] flex justify-center items-center pointer-events-auto p-4 animate-fade-in select-none">
          <div className="bg-slate-900 border border-slate-800 rounded-xl shadow-2xl p-5 w-[385px] text-center">
            <div className="w-12 h-12 bg-rose-500/10 border border-rose-500/20 text-rose-500 rounded-full flex items-center justify-center mx-auto mb-3">
              <AlertTriangle className="w-6 h-6 animate-pulse" />
            </div>
            <h3 className="text-white font-bold text-sm uppercase tracking-wide mb-2">
              {confirmAction.title || 'Xác nhận'}
            </h3>
            <p className="text-slate-300 text-xs mb-5 leading-relaxed">
              {confirmAction.message}
            </p>
            <div className="flex justify-center gap-3 text-xs font-semibold">
              <button
                onClick={() => setConfirmAction(null)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded transition cursor-pointer border border-slate-700"
              >
                Hủy bỏ
              </button>
              <button
                onClick={() => {
                  confirmAction.onConfirm();
                  setConfirmAction(null);
                }}
                className={`px-4 py-2 rounded text-white transition cursor-pointer ${
                  confirmAction.btnColor || 'bg-rose-600 hover:bg-rose-500'
                }`}
              >
                {confirmAction.btnText || 'Xác nhận'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

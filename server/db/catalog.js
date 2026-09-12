// ============================================================================
// Catálogo base del CDH. Todo esto es CONFIGURABLE desde Administración;
// aquí sólo se define el punto de partida.
// ============================================================================

export const DEPARTMENTS = [
  { code: 'AMA',        name: 'Ama de Llaves',  color: '#7c3aed', sort_order: 1 },
  { code: 'MTTO',       name: 'Mantenimiento',  color: '#ea580c', sort_order: 2 },
  { code: 'SIS',        name: 'Sistemas',       color: '#0284c7', sort_order: 3 },
  { code: 'RECEPCION',  name: 'Recepción',      color: '#059669', sort_order: 4 },
  { code: 'SUPERVISION',name: 'Supervisión',    color: '#c2410c', sort_order: 5 },
  { code: 'GERENCIA',   name: 'Gerencia',       color: '#1e293b', sort_order: 6 },
  { code: 'SISTEMAS_TI',name: 'Administración', color: '#475569', sort_order: 7 },
];

export const PERMISSIONS = [
  { code: 'room.view',        grp: 'Habitaciones', name: 'Ver habitaciones' },
  { code: 'room.edit',        grp: 'Habitaciones', name: 'Editar detalles de habitación' },
  { code: 'room.status',      grp: 'Habitaciones', name: 'Cambiar estado de habitación' },
  { code: 'room.occupancy',   grp: 'Habitaciones', name: 'Registrar ocupación (entrada y salida de huésped)' },
  { code: 'movement.create',  grp: 'Habitaciones', name: 'Crear movimientos' },
  { code: 'history.view',     grp: 'Habitaciones', name: 'Ver historial' },
  { code: 'photo.upload',     grp: 'Habitaciones', name: 'Adjuntar fotografías' },
  { code: 'report.view',      grp: 'Reportes',     name: 'Ver reportes' },
  { code: 'report.export',    grp: 'Reportes',     name: 'Exportar (Excel/CSV/PDF)' },
  { code: 'dashboard.manage', grp: 'Reportes',     name: 'Ver dashboard gerencial' },
  { code: 'audit.view',       grp: 'Auditoría',    name: 'Consultar bitácora de auditoría' },
  { code: 'notification.manage', grp: 'Auditoría', name: 'Atender notificaciones' },
  { code: 'admin.users',      grp: 'Administración', name: 'Administrar usuarios, roles y permisos' },
  { code: 'admin.rooms',      grp: 'Administración', name: 'Administrar habitaciones y pisos' },
  { code: 'admin.catalog',    grp: 'Administración', name: 'Administrar categorías, campos y estados' },
  { code: 'admin.settings',   grp: 'Administración', name: 'Administrar configuraciones' },
];

const OPERATIVO = ['room.view','room.edit','room.status','room.occupancy','movement.create','history.view','photo.upload','report.view'];

export const ROLES = [
  { code: 'ADMIN', name: 'Administrador', department_scope: 0, is_system: 1,
    description: 'Acceso completo al sistema.',
    permissions: PERMISSIONS.map((p) => p.code) },

  { code: 'GERENCIA', name: 'Gerencia', department_scope: 0, is_system: 1,
    description: 'Consulta todo el hotel, sin modificar operación.',
    permissions: ['room.view','history.view','report.view','report.export','dashboard.manage','audit.view','notification.manage'] },

  { code: 'SUPERVISOR', name: 'Supervisor', department_scope: 0, is_system: 1,
    description: 'Opera y valida todas las categorías, sin acceso a administración.',
    permissions: [...OPERATIVO,'report.export','dashboard.manage','audit.view','notification.manage'] },

  { code: 'AMA', name: 'Ama de Llaves', department_scope: 1, is_system: 1,
    description: 'Gestiona los campos de Ama de Llaves.',
    permissions: OPERATIVO },

  { code: 'MTTO', name: 'Mantenimiento', department_scope: 1, is_system: 1,
    description: 'Gestiona los campos de Mantenimiento.',
    permissions: OPERATIVO },

  { code: 'SIS', name: 'Sistemas', department_scope: 1, is_system: 1,
    description: 'Gestiona los campos de Sistemas.',
    permissions: OPERATIVO },

  { code: 'RECEPCION', name: 'Recepción', department_scope: 1, is_system: 1,
    description: 'Consulta habitaciones y registra observaciones autorizadas.',
    permissions: ['room.view','room.occupancy','movement.create','history.view','photo.upload','report.view'] },

  { code: 'OTROS', name: 'Otros', department_scope: 1, is_system: 0,
    description: 'Consulta básica.',
    permissions: ['room.view','history.view'] },
];

// `counts_attention` decide si el estado entra en "Requiere atención";
// `attention_weight` decide qué tan arriba aparece (bloqueo > trabajo
// pendiente > inspección). Un estado nuevo con counts_attention = 1 aparece
// en la lista sin tocar una sola línea de código.
export const ROOM_STATUSES = [
  { code:'DISPONIBLE',           name:'Disponible',            icon:'check-circle', color:'#16a34a', counts_ready:1, requires_vacant:1 },
  { code:'OCUPADA',              name:'Ocupada',               icon:'user',         color:'#2563eb' },
  { code:'VACIA',                name:'Vacía',                 icon:'door',         color:'#64748b', counts_pending:1 },
  { code:'EN_LIMPIEZA',          name:'En limpieza',           icon:'spray',        color:'#0891b2', counts_cleaning:1 },
  { code:'LIMPIEZA_TERMINADA',   name:'Limpieza terminada',    icon:'sparkles',     color:'#06b6d4', counts_pending:1 },
  { code:'INSPECCION_PENDIENTE', name:'Inspección pendiente',  icon:'clipboard',    color:'#d97706', counts_pending:1, counts_attention:1, attention_weight:2 },
  { code:'INSPECCIONADA',        name:'Inspeccionada',         icon:'shield-check', color:'#15803d', counts_ready:1 },
  { code:'MANT_PENDIENTE',       name:'Mantenimiento pendiente',icon:'wrench',      color:'#f59e0b', counts_maintenance:1, counts_pending:1, counts_attention:1, attention_weight:3 },
  { code:'EN_MANTENIMIENTO',     name:'En mantenimiento',      icon:'tool',         color:'#ea580c', counts_maintenance:1 },
  { code:'SIS_PENDIENTE',        name:'Sistemas pendiente',    icon:'wifi',         color:'#0284c7', counts_pending:1, counts_attention:1, attention_weight:3 },
  { code:'EN_SISTEMAS',          name:'En atención de Sistemas', icon:'wifi',       color:'#0369a1' },
  { code:'FUERA_SERVICIO',       name:'Fuera de servicio',     icon:'ban',          color:'#b91c1c', counts_blocked:1, counts_attention:1, attention_weight:4 },
  { code:'BLOQUEADA',            name:'Bloqueada',             icon:'lock',         color:'#7f1d1d', counts_blocked:1, counts_attention:1, attention_weight:4 },
  { code:'REQUIERE_ATENCION',    name:'Requiere atención',     icon:'alert',        color:'#dc2626', counts_attention:1, counts_pending:1, attention_weight:4 },
];

// La OCUPACIÓN va aparte del estado. El estado dice en qué punto del ciclo de
// limpieza está la habitación; la ocupación, si hay huésped dentro. Ama de
// Llaves necesita las dos cosas a la vez: una habitación sucia con el huésped
// en casa y una sucia de salida se atienden distinto.
// Los nombres dicen lo que la camarista necesita saber en el pasillo, no el
// término de recepción: "Huésped ahí" y "Huésped ausente" no se confunden con
// el estado de la habitación; "Ocupada" y "Vacante" sí.
export const ROOM_OCCUPANCIES = [
  { code:'VACANTE',     name:'Huésped ausente', icon:'door', color:'#64748b', is_default:1,
    description:'No hay huésped. Puede venderse en cuanto su estado lo permita.' },
  { code:'OCUPADA',     name:'Huésped ahí', icon:'user',   color:'#2563eb', counts_occupied:1,
    target_status:'OCUPADA',
    description:'Hay huésped en casa. La habitación no puede quedar a la venta.' },
  { code:'SALIDA',      name:'Salida',      icon:'logout', color:'#d97706',
    description:'El huésped ya se fue; la habitación espera limpieza de salida.' },
  { code:'NO_MOLESTAR', name:'No molestar', icon:'ban',    color:'#7c3aed', counts_occupied:1, do_not_disturb:1,
    target_status:'OCUPADA',
    description:'Hay huésped y pidió no ser molestado: no se entra a la habitación.' },
];

const EST_MTTO   = ['OK','Requiere revisión','Falla','Fuera de servicio'];
const INC_MTTO   = ['Requiere revisión','Falla','Fuera de servicio'];
const EST_SIS    = ['OK','Intermitente','Sin servicio','Fuera de servicio'];
const INC_SIS    = ['Intermitente','Sin servicio','Fuera de servicio'];

export const CATEGORIES = [
  { code:'AMA', name:'Ama de Llaves', department:'AMA', icon:'spray', color:'#7c3aed', sort_order:1, fields:[
    { code:'limpieza',   label:'Limpieza',    type:'select', options:['Pendiente','En proceso','Terminada','Rechazada'], default_value:'Pendiente', is_incident_when:['Rechazada'] },
    { code:'inspeccion', label:'Inspección',  type:'select', options:['Pendiente','Aprobada','Rechazada'], default_value:'Pendiente', is_incident_when:['Rechazada'] },
    { code:'blancos',    label:'Blancos',     type:'select', options:['Completo','Incompleto','Requiere cambio','Dañado'], default_value:'Completo', is_incident_when:['Incompleto','Requiere cambio','Dañado'] },
    { code:'amenidades', label:'Amenidades',  type:'select', options:['Completas','Incompletas','Requiere surtido'], default_value:'Completas', is_incident_when:['Incompletas','Requiere surtido'] },
    { code:'minibar',    label:'Minibar',     type:'select', options:['Completo','Consumido','Incompleto','Sin servicio'], default_value:'Completo', is_incident_when:['Sin servicio'] },
    { code:'danios',     label:'Daños',       type:'select', options:['Sin daños','Daño menor','Daño mayor'], default_value:'Sin daños', is_incident_when:['Daño menor','Daño mayor'] },
    { code:'objetos_encontrados', label:'Objetos encontrados', type:'text' },
    { code:'observaciones_ama',   label:'Observaciones',       type:'textarea' },
  ]},
  { code:'MTTO', name:'Mantenimiento', department:'MTTO', icon:'wrench', color:'#ea580c', sort_order:2, blocks_release:1, pending_status:'MANT_PENDIENTE', fields:[
    { code:'electricidad', label:'Electricidad', type:'select', options:EST_MTTO, default_value:'OK', is_incident_when:INC_MTTO },
    { code:'plomeria',     label:'Plomería',     type:'select', options:EST_MTTO, default_value:'OK', is_incident_when:INC_MTTO },
    { code:'hvac',         label:'HVAC (clima)', type:'select', options:EST_MTTO, default_value:'OK', is_incident_when:INC_MTTO },
    { code:'mobiliario',   label:'Mobiliario',   type:'select', options:EST_MTTO, default_value:'OK', is_incident_when:INC_MTTO },
    { code:'bano',         label:'Baño',         type:'select', options:EST_MTTO, default_value:'OK', is_incident_when:INC_MTTO },
    { code:'cerraduras',   label:'Cerraduras',   type:'select', options:EST_MTTO, default_value:'OK', is_incident_when:INC_MTTO },
    { code:'otros_mtto',   label:'Otros (mantenimiento)', type:'textarea' },
  ]},
  { code:'SIS', name:'Sistemas', department:'SIS', icon:'wifi', color:'#0284c7', sort_order:3, blocks_release:1, pending_status:'SIS_PENDIENTE', fields:[
    { code:'telefono',     label:'Teléfono',     type:'select', options:EST_SIS, default_value:'OK', is_incident_when:INC_SIS },
    { code:'tv',           label:'TV',           type:'select', options:EST_SIS, default_value:'OK', is_incident_when:INC_SIS },
    { code:'wifi',         label:'WiFi',         type:'select', options:EST_SIS, default_value:'OK', is_incident_when:INC_SIS },
    { code:'cast',         label:'Cast',         type:'select', options:EST_SIS, default_value:'OK', is_incident_when:INC_SIS },
    { code:'panel_tactil', label:'Panel táctil', type:'select', options:EST_SIS, default_value:'OK', is_incident_when:INC_SIS },
    { code:'red',          label:'Red',          type:'select', options:EST_SIS, default_value:'OK', is_incident_when:INC_SIS },
    { code:'equipos',      label:'Equipos',      type:'textarea' },
  ]},
  { code:'OTROS', name:'Otros', department:null, icon:'folder', color:'#64748b', sort_order:4, fields:[
    { code:'seguridad',    label:'Seguridad',    type:'select', options:['Sin novedad','Requiere atención','Incidente'], default_value:'Sin novedad', is_incident_when:['Requiere atención','Incidente'] },
    { code:'recepcion',    label:'Recepción',    type:'textarea' },
    { code:'observaciones_generales', label:'Observaciones generales', type:'textarea' },
  ]},
];

// Acciones rápidas: cada una genera automáticamente un movimiento auditable.
export const MOVEMENT_TYPES = [
  { code:'CLEAN_DONE',  name:'Limpieza terminada',      category:'AMA',  target_status:'LIMPIEZA_TERMINADA',  icon:'sparkles',     is_quick_action:1, sort_order:1 },
  { code:'CLEAN_START', name:'Iniciar limpieza',        category:'AMA',  target_status:'EN_LIMPIEZA',         icon:'spray',        is_quick_action:0, sort_order:2 },
  { code:'INSPECTION',  name:'Inspección',              category:'AMA',  target_status:'INSPECCIONADA',       icon:'clipboard',    is_quick_action:1, sort_order:3 },
  { code:'MAINT_REPORT',name:'Reportar mantenimiento',  category:'MTTO', target_status:'MANT_PENDIENTE',      icon:'wrench',       is_quick_action:1, is_incident:1, severity:'alta', requires_comment:1, notify:1, cross_department:1, sort_order:4 },
  { code:'MAINT_START', name:'Iniciar mantenimiento',   category:'MTTO', target_status:'EN_MANTENIMIENTO',    icon:'tool',         is_quick_action:0, sort_order:5 },
  { code:'MAINT_DONE',  name:'Mantenimiento completado',category:'MTTO', target_status:'INSPECCION_PENDIENTE',icon:'check-circle', is_quick_action:1, closes_incident:1, notify:1, sort_order:6 },
  { code:'SYS_REPORT',  name:'Reportar a Sistemas',     category:'SIS',  target_status:'SIS_PENDIENTE',       icon:'wifi',         is_quick_action:1, is_incident:1, severity:'alta', requires_comment:1, notify:1, cross_department:1, sort_order:7 },
  { code:'SYS_START',   name:'Iniciar atención de Sistemas', category:'SIS', target_status:'EN_SISTEMAS',    icon:'tool',         is_quick_action:0, sort_order:8 },
  { code:'SYS_DONE',    name:'Sistemas completado',     category:'SIS',  target_status:'INSPECCION_PENDIENTE',icon:'check-circle', is_quick_action:1, closes_incident:1, notify:1, sort_order:9 },
  { code:'BLOCK',       name:'Bloquear habitación',     category:'OTROS',target_status:'BLOQUEADA',           icon:'lock',         is_quick_action:1, is_incident:1, severity:'alta', requires_comment:1, notify:1, sort_order:10 },
  { code:'RELEASE',     name:'Liberar habitación',      category:'OTROS',target_status:'DISPONIBLE',          icon:'unlock',       is_quick_action:1, closes_incident:1, closes_scope:'habitacion', sort_order:11 },
  { code:'DAMAGE',      name:'Reportar daño',           category:'AMA',  target_status:'REQUIERE_ATENCION',   icon:'alert',        is_quick_action:1, is_incident:1, severity:'critica', requires_comment:1, notify:1, sort_order:12 },
  { code:'NOTE',        name:'Agregar observación',     category:'OTROS',target_status:null,                  icon:'note',         is_quick_action:1, requires_comment:1, sort_order:13 },
  { code:'PHOTO',       name:'Agregar foto',            category:'OTROS',target_status:null,                  icon:'camera',       is_quick_action:1, requires_photo:1, sort_order:14 },
  { code:'OUT_OF_SERVICE', name:'Marcar fuera de servicio', category:'MTTO', target_status:'FUERA_SERVICIO',  icon:'ban',          is_quick_action:0, is_incident:1, severity:'critica', requires_comment:1, notify:1, sort_order:15 },
  { code:'CHECK_IN',    name:'Entrada de huésped',      category:'OTROS',target_status:null,  target_occupancy:'OCUPADA',     icon:'user',   is_quick_action:1, sort_order:16 },
  { code:'CHECK_OUT',   name:'Salida de huésped',       category:'OTROS',target_status:null,  target_occupancy:'SALIDA',      icon:'logout', is_quick_action:1, sort_order:17 },
  { code:'DND_ON',      name:'Marcar no molestar',      category:'OTROS',target_status:null,  target_occupancy:'NO_MOLESTAR', icon:'ban',    is_quick_action:1, sort_order:18 },
  { code:'DND_OFF',     name:'Quitar no molestar',      category:'OTROS',target_status:null,  target_occupancy:'OCUPADA',     icon:'user',   is_quick_action:1, sort_order:19 },
  { code:'STATUS_CHANGE', name:'Cambio de estado',      category:null,   target_status:null,                  icon:'swap',         is_quick_action:0, is_system:1, sort_order:20 },
  { code:'DETAIL_UPDATE', name:'Actualización de detalle', category:null,target_status:null,                  icon:'edit',         is_quick_action:0, is_system:1, sort_order:21 },
  { code:'OCCUPANCY_CHANGE', name:'Cambio de ocupación', category:null,  target_status:null,                  icon:'swap',         is_quick_action:0, is_system:1, sort_order:22 },
];

export const ROOM_TYPES = [
  { code:'SEN', name:'Sencilla',   sort_order:1 },
  { code:'DBL', name:'Doble',      sort_order:2 },
  { code:'JRS', name:'Junior Suite', sort_order:3 },
  { code:'SUI', name:'Suite',      sort_order:4 },
  { code:'ACC', name:'Accesible',  sort_order:5 },
];

// ============================================================================
// DISTRIBUCIÓN REAL DEL HOTEL QUARTZ (según la captura del rack vertical).
// El índice del arreglo es la columna visual: 0 -> A, 1 -> B ... 18 -> S.
// `null` = espacio sin habitación; debe permanecer VACÍO en el mapa.
// ============================================================================
export const FLOOR_MAP = [
  { number: 3,  name: 'Piso 3',  rooms: [301,302,303,304,305,306,307,308,309,310,311,312,null,null,null,null,null,null,null] },
  { number: 4,  name: 'Piso 4',  rooms: [401,402,403,404,405,406,408,410,411,412,413,414,415,416,417,418,419,420,422] },
  { number: 5,  name: 'Piso 5',  rooms: [501,502,503,504,505,506,508,510,512,513,514,515,516,517,518,519,520,522,null] },
  { number: 6,  name: 'Piso 6',  rooms: [601,602,603,604,605,606,608,610,611,612,613,614,615,616,617,618,619,620,622] },
  { number: 7,  name: 'Piso 7',  rooms: [701,702,703,704,705,706,708,710,711,712,713,714,715,716,717,718,719,720,722] },
  { number: 8,  name: 'Piso 8',  rooms: [801,802,803,804,805,806,808,810,811,812,813,814,815,816,817,818,819,820,822] },
  { number: 9,  name: 'Piso 9',  rooms: [901,902,903,904,905,906,908,910,911,912,913,914,915,916,917,918,919,920,922] },
  { number: 10, name: 'Piso 10', rooms: [1001,1002,1003,1004,1005,1006,1008,1010,1011,1012,1013,1014,1015,1016,1017,1018,1019,1020,1022] },
  { number: 11, name: 'Piso 11', rooms: [1101,1102,1103,1104,1106,1107,1108,1109,1110,1111,1112,null,null,null,null,null,null,null,null] },
];

export const GRID_COLUMNS = 19; // A..S

export const SETTINGS = [
  { key:'hotel_name',        value:'Hotel Quartz',        label:'Nombre del hotel',            grp:'General', type:'text' },
  { key:'app_name',          value:'CDH',                 label:'Nombre del sistema',          grp:'General', type:'text' },
  { key:'timezone',          value:'America/Tijuana',     label:'Zona horaria del hotel',      grp:'General', type:'timezone' },
  { key:'target_room_count', value:'155',                 label:'Total de habitaciones objetivo', grp:'General', type:'number' },
  { key:'recurrence_window_days', value:'30',             label:'Ventana de reincidencia (días)', grp:'Operación', type:'number' },
  { key:'recurrence_thresholds',  value:'2,3,5,10',       label:'Umbrales de reincidencia',    grp:'Operación', type:'text' },
  { key:'activity_feed_size',     value:'25',             label:'Movimientos en actividad reciente', grp:'Operación', type:'number' },
  { key:'bulk_max_rooms',         value:'40',             label:'Máximo de habitaciones por cambio en bloque', grp:'Operación', type:'number' },
  { key:'notify_critical',        value:'1',              label:'Notificar incidencias críticas', grp:'Notificaciones', type:'boolean' },
  { key:'notify_blocked',         value:'1',              label:'Notificar habitaciones bloqueadas', grp:'Notificaciones', type:'boolean' },
  { key:'notify_maintenance',     value:'1',              label:'Notificar mantenimiento crítico', grp:'Notificaciones', type:'boolean' },
  { key:'notify_housekeeping_copy', value:'1',            label:'Copiar siempre a Ama de Llaves',  grp:'Notificaciones', type:'boolean' },
  { key:'session_hours',          value:'12',             label:'Duración de sesión (horas)',  grp:'Seguridad', type:'number' },
  { key:'max_photo_mb',           value:'8',              label:'Tamaño máximo por foto (MB)', grp:'Seguridad', type:'number' },
];

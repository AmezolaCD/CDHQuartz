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
  { code: 'movement.create',  grp: 'Habitaciones', name: 'Crear movimientos' },
  { code: 'cleaning.request', grp: 'Habitaciones', name: 'Solicitar limpieza de habitaciones' },
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

const OPERATIVO = ['room.view','room.edit','room.status','movement.create','cleaning.request','history.view','photo.upload','report.view'];

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
    permissions: ['room.view','room.status','movement.create','cleaning.request','history.view','photo.upload','report.view'] },

  { code: 'OTROS', name: 'Otros', department_scope: 1, is_system: 0,
    description: 'Consulta básica.',
    permissions: ['room.view','history.view'] },
];

// Los estados son los que maneja Arpón, el PMS del hotel, con sus mismos
// nombres: el rack del CDH y la pantalla de Ama de Llaves de Arpón tienen que
// poder leerse una junto a la otra sin traducir nada.
//
// `counts_attention` decide si el estado entra en "Requiere atención" y
// `attention_weight` qué tan arriba aparece. `clean_status` dice a dónde pasa
// la habitación al terminar de limpiarla, que no es el mismo sitio si el
// huésped se queda que si ya se fue.
export const ROOM_STATUSES = [
  { code:'DISPONIBLE_LIMPIO', name:'Disponible limpio', icon:'check-circle', color:'#16a34a', counts_ready:1,
    description:'Sin huésped, aseada y lista para venderse.' },
  { code:'ENTRADA_NUEVA',     name:'Entrada nueva',     icon:'door',         color:'#0891b2',
    description:'Preparada para el huésped que llega.' },
  { code:'OCUPADO_LIMPIO',    name:'Ocupado limpio',    icon:'user',         color:'#2563eb',
    description:'Con huésped y ya atendida.' },
  { code:'OCUPADO_SUCIO',     name:'Ocupado sucio',     icon:'spray',        color:'#d97706',
    counts_cleaning:1, counts_pending:1, clean_status:'OCUPADO_LIMPIO',
    description:'Con huésped, pendiente de limpieza.' },
  { code:'SALIDA',            name:'Salida',            icon:'logout',       color:'#f59e0b',
    counts_cleaning:1, counts_pending:1, clean_status:'DISPONIBLE_LIMPIO',
    description:'El huésped se fue; pendiente de limpieza de salida.' },
  { code:'DISCREPANCIA',      name:'Discrepancia',      icon:'alert',        color:'#dc2626',
    counts_attention:1, counts_pending:1, attention_weight:4,
    description:'Lo que ve Ama de Llaves no coincide con lo que dice Recepción.' },
  { code:'FUERA_SERVICIO',    name:'Fuera de servicio', icon:'ban',          color:'#b91c1c',
    counts_blocked:1, counts_attention:1, attention_weight:4,
    description:'No se puede vender: tiene una falla que lo impide.' },
];

// Prioridad de una solicitud de limpieza. Lo que ordena la cola es `weight`,
// no el nombre ni el color: así el hotel puede intercalar una prioridad nueva
// entre dos existentes sin tocar código.
export const CLEANING_PRIORITIES = [
  { code:'BAJA',    name:'Baja',    icon:'clock', color:'#64748b', weight:1, notify_severity:'normal',
    description:'Cuando se pueda, sin prisa.' },
  { code:'MEDIA',   name:'Media',   icon:'clock', color:'#0891b2', weight:2, notify_severity:'normal',
    description:'Dentro del turno.' },
  { code:'ALTA',    name:'Alta',    icon:'alert', color:'#d97706', weight:3, notify_severity:'alta',
    description:'Antes que el resto del piso.' },
  { code:'URGENTE', name:'Urgente', icon:'alert', color:'#dc2626', weight:4, notify_severity:'critica',
    description:'El huésped está esperando.' },
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
    // El código sigue siendo `minibar`: es lo que enlaza el valor guardado de
    // cada habitación con este campo. Cambiarlo crearía un campo nuevo y
    // dejaría atrás el histórico de todas las habitaciones.
    { code:'minibar',    label:'Refrigerador',type:'select', options:['Completo','Consumido','Incompleto','Sin servicio'], default_value:'Completo', is_incident_when:['Sin servicio'] },
    { code:'danios',     label:'Daños',       type:'select', options:['Sin daños','Daño menor','Daño mayor'], default_value:'Sin daños', is_incident_when:['Daño menor','Daño mayor'] },
    { code:'objetos_encontrados', label:'Objetos encontrados', type:'text' },
    { code:'observaciones_ama',   label:'Observaciones',       type:'textarea' },
  ]},
  { code:'MTTO', name:'Mantenimiento', department:'MTTO', icon:'wrench', color:'#ea580c', sort_order:2, blocks_release:1, pending_status:'FUERA_SERVICIO', fields:[
    { code:'electricidad', label:'Electricidad', type:'select', options:EST_MTTO, default_value:'OK', is_incident_when:INC_MTTO },
    { code:'plomeria',     label:'Plomería',     type:'select', options:EST_MTTO, default_value:'OK', is_incident_when:INC_MTTO },
    { code:'hvac',         label:'HVAC (clima)', type:'select', options:EST_MTTO, default_value:'OK', is_incident_when:INC_MTTO },
    { code:'mobiliario',   label:'Mobiliario',   type:'select', options:EST_MTTO, default_value:'OK', is_incident_when:INC_MTTO },
    { code:'bano',         label:'Baño',         type:'select', options:EST_MTTO, default_value:'OK', is_incident_when:INC_MTTO },
    { code:'cerraduras',   label:'Cerraduras',   type:'select', options:EST_MTTO, default_value:'OK', is_incident_when:INC_MTTO },
    { code:'otros_mtto',   label:'Otros (mantenimiento)', type:'textarea' },
  ]},
  { code:'SIS', name:'Sistemas', department:'SIS', icon:'wifi', color:'#0284c7', sort_order:3, blocks_release:1, pending_status:'FUERA_SERVICIO', fields:[
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
//
// `asks_guest_present` marca las que preguntan si el huésped estará en la
// habitación. Es lo que Mantenimiento y Sistemas necesitan saber antes de
// subir, y por eso viaja con el reporte en vez de ser un estado aparte.
//
// Los reportes NO mueven el estado: el estado lo manda Ama de Llaves y refleja
// el ciclo de limpieza del PMS. Un reporte abierto ya impide por sí solo que
// la habitación quede disponible, así que no hace falta un estado para eso.
export const MOVEMENT_TYPES = [
  { code:'CLEAN_DONE',  name:'Limpieza terminada',      category:'AMA',  target_status:null, target_from_clean:1, icon:'sparkles', is_quick_action:1, closes_cleaning_request:1, sort_order:1 },
  { code:'INSPECTION',  name:'Inspección',              category:'AMA',  target_status:null,                  icon:'clipboard',    is_quick_action:1, sort_order:2 },
  { code:'GUEST_OUT',   name:'Salida de huésped',       category:'OTROS',target_status:'SALIDA',              icon:'logout',       is_quick_action:1, warns_pms:1, sort_order:3 },
  { code:'DELIVER',     name:'Entregar habitación',     category:'OTROS',target_status:'ENTRADA_NUEVA',       icon:'door',         is_quick_action:1, warns_pms:1, sort_order:4 },
  { code:'GUEST_IN',    name:'Entrada de huésped',      category:'OTROS',target_status:'OCUPADO_LIMPIO',      icon:'user',         is_quick_action:1, warns_pms:1, sort_order:5 },
  { code:'MAINT_REPORT',name:'Reportar mantenimiento',  category:'MTTO', target_status:null,                  icon:'wrench',       is_quick_action:1, is_incident:1, severity:'alta', requires_comment:1, notify:1, cross_department:1, asks_guest_present:1, sort_order:5 },
  { code:'MAINT_DONE',  name:'Mantenimiento completado',category:'MTTO', target_status:null,                  icon:'check-circle', is_quick_action:1, closes_incident:1, notify:1, sort_order:6 },
  { code:'SYS_REPORT',  name:'Reportar a Sistemas',     category:'SIS',  target_status:null,                  icon:'wifi',         is_quick_action:1, is_incident:1, severity:'alta', requires_comment:1, notify:1, cross_department:1, asks_guest_present:1, sort_order:7 },
  { code:'SYS_DONE',    name:'Sistemas completado',     category:'SIS',  target_status:null,                  icon:'check-circle', is_quick_action:1, closes_incident:1, notify:1, sort_order:8 },
  { code:'DAMAGE',      name:'Reportar daño',           category:'AMA',  target_status:null,                  icon:'alert',        is_quick_action:1, is_incident:1, severity:'critica', requires_comment:1, notify:1, asks_guest_present:1, sort_order:9 },
  { code:'DISCREPANCY', name:'Reportar discrepancia',   category:'AMA',  target_status:'DISCREPANCIA',        icon:'alert',        is_quick_action:1, is_incident:1, severity:'alta', requires_comment:1, notify:1, cross_department:1, asks_guest_present:1, sort_order:10 },
  { code:'OUT_OF_SERVICE', name:'Marcar fuera de servicio', category:'MTTO', target_status:'FUERA_SERVICIO',  icon:'ban',          is_quick_action:1, is_incident:1, severity:'critica', requires_comment:1, notify:1, cross_department:1, asks_guest_present:1, sort_order:11 },
  { code:'RELEASE',     name:'Liberar habitación',      category:'OTROS',target_status:'DISPONIBLE_LIMPIO',   icon:'unlock',       is_quick_action:1, closes_incident:1, closes_scope:'habitacion', sort_order:12 },
  { code:'NOTE',        name:'Agregar observación',     category:'OTROS',target_status:null,                  icon:'note',         is_quick_action:1, requires_comment:1, sort_order:13 },
  { code:'PHOTO',       name:'Agregar foto',            category:'OTROS',target_status:null,                  icon:'camera',       is_quick_action:1, requires_photo:1, sort_order:14 },
  // Las solicitudes de limpieza no son acciones rápidas: se piden desde el
  // centro de solicitudes o desde el expediente, que es donde se elige la
  // prioridad. Existen como tipo para que cada cambio deje su movimiento.
  { code:'CLEAN_REQUEST',        name:'Solicitud de limpieza',            category:'AMA', target_status:null, icon:'spray',    is_quick_action:0, is_system:1, notify:1, cross_department:1, sort_order:30 },
  { code:'CLEAN_REQUEST_RAISE',  name:'Prioridad de limpieza elevada',    category:'AMA', target_status:null, icon:'alert',    is_quick_action:0, is_system:1, notify:1, cross_department:1, sort_order:31 },
  { code:'CLEAN_REQUEST_DONE',   name:'Solicitud de limpieza atendida',   category:'AMA', target_status:null, icon:'check',    is_quick_action:0, is_system:1, cross_department:1, sort_order:32 },
  { code:'CLEAN_REQUEST_CANCEL', name:'Solicitud de limpieza cancelada',  category:'AMA', target_status:null, icon:'x',        is_quick_action:0, is_system:1, cross_department:1, sort_order:33 },
  { code:'STATUS_CHANGE', name:'Cambio de estado',      category:null,   target_status:null,                  icon:'swap',         is_quick_action:0, is_system:1, sort_order:20 },
  { code:'DETAIL_UPDATE', name:'Actualización de detalle', category:null,target_status:null,                  icon:'edit',         is_quick_action:0, is_system:1, sort_order:21 },
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
  { key:'pms_name',               value:'Arpón Enterprise', label:'Nombre del PMS del hotel',  grp:'Operación', type:'text' },
  { key:'pms_manual_sync',        value:'1',              label:'Avisar que el cambio debe repetirse en el PMS', grp:'Operación', type:'boolean' },
  { key:'notify_critical',        value:'1',              label:'Notificar incidencias críticas', grp:'Notificaciones', type:'boolean' },
  { key:'notify_blocked',         value:'1',              label:'Notificar habitaciones bloqueadas', grp:'Notificaciones', type:'boolean' },
  { key:'notify_maintenance',     value:'1',              label:'Notificar mantenimiento crítico', grp:'Notificaciones', type:'boolean' },
  { key:'notify_housekeeping_copy', value:'1',            label:'Copiar siempre a Ama de Llaves',  grp:'Notificaciones', type:'boolean' },
  { key:'session_hours',          value:'12',             label:'Duración de sesión (horas)',  grp:'Seguridad', type:'number' },
  { key:'max_photo_mb',           value:'8',              label:'Tamaño máximo por foto (MB)', grp:'Seguridad', type:'number' },
];

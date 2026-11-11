'use strict';

const DEPARTMENTS = Object.freeze(['Mining','Workshop','REMAN','Parts Receival','Parts Despatch','Facilities','Office','Other']);
const TRADES = Object.freeze(['Boilermaker','Fitter','Electrician','Mechanic','Welder','Supervisor','Other']);
const ENCLOSURES = Object.freeze(['fully_enclosed','open_workshop','outdoors']);
const CONDITIONS = Object.freeze(['in_service','out_of_service','missing']);
const STATUSES = Object.freeze(['submitted','under_review','reviewed','notification_recorded','completed','cancelled']);
const STATUS_NEXT = Object.freeze({
  submitted: ['under_review','cancelled'],
  under_review: ['reviewed','cancelled'],
  reviewed: ['under_review','notification_recorded','completed','cancelled'],
  notification_recorded: ['under_review','completed','cancelled'],
  completed: [], cancelled: [],
});

class FireOpsError extends Error {
  constructor(status, code, message = code) { super(message); this.status = status; this.code = code; }
}
function bad(message) { throw new FireOpsError(400, 'INVALID_FIRE_OPS_DATA', message); }
function str(input, field, max = 200, required = false) {
  if (input == null && !required) return '';
  if (typeof input !== 'string') bad(`${field} must be text`);
  const value = input.trim();
  if (value.length > max || (required && !value)) bad(`${field} is required (max ${max} characters)`);
  return value;
}
function option(input, values, field) {
  if (!values.includes(input)) bad(`Choose a valid ${field}`);
  return input;
}
function isoDate(input, field, required = false) {
  if ((input === '' || input == null) && !required) return null;
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input)) bad(`Invalid ${field}`);
  const date = new Date(`${input}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0,10) !== input) bad(`Invalid ${field}`);
  return input;
}
function clock(input) {
  if (typeof input !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input)) bad('Invalid work time');
  return input;
}
function optionalBool(input, field) {
  if (input == null || input === '') return null;
  if (typeof input !== 'boolean') bad(`${field} must be yes, no, or unknown`);
  return input;
}
function uuid(input, field) {
  if (input == null || input === '') return null;
  if (typeof input !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)) bad(`Invalid ${field}`);
  return input;
}
function building(input) {
  const value = str(input,'SiteNav building',80,true);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) bad('Invalid SiteNav building ID');
  return value;
}

function validateHotWork(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('Invalid work request');
  const startTime = clock(input.startTime), endTime = clock(input.endTime);
  if (endTime <= startTime) bad('End time must be later on the same day');
  return {
    workDate: isoDate(input.workDate,'work date',true), startTime, endTime,
    department: option(input.department,DEPARTMENTS,'department'),
    trade: option(input.trade,TRADES,'trade'),
    buildingRef: building(input.buildingRef),
    locationDetail: str(input.locationDetail,'exact location',250,true),
    description: str(input.description,'description',1200,true),
    equipment: str(input.equipment,'equipment/process',300,true),
    enclosure: option(input.enclosure,ENCLOSURES,'enclosure'),
    vegetationWithin30m: optionalBool(input.vegetationWithin30m,'vegetation'),
    dbcaWithin3km: optionalBool(input.dbcaWithin3km,'DBCA proximity'),
    controls: str(input.controls,'risk controls',1500),
    fireWatchEmployeeId: uuid(input.fireWatchEmployeeId,'fire-watch employee'),
  };
}

function validateStaff(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('Invalid staff record');
  return {
    id: uuid(input.id,'employee ID'),
    employeeNumber: str(input.employeeNumber,'employee number',40) || null,
    fullName: str(input.fullName,'employee name',120,true),
    department: option(input.department,DEPARTMENTS,'department'),
    trade: option(input.trade,TRADES,'trade'),
    extinguisherTrainedOn: isoDate(input.extinguisherTrainedOn,'extinguisher training date'),
    extinguisherExpiresOn: isoDate(input.extinguisherExpiresOn,'extinguisher expiry/reassessment date'),
    fireWatchTrainedOn: isoDate(input.fireWatchTrainedOn,'fire-watch training date'),
    fireWatchExpiresOn: isoDate(input.fireWatchExpiresOn,'fire-watch expiry/reassessment date'),
    fireVehicleTrainedOn: isoDate(input.fireVehicleTrainedOn,'firefighting vehicle training date'),
    fireVehicleExpiresOn: isoDate(input.fireVehicleExpiresOn,'firefighting vehicle expiry/reassessment date'),
    bushfireTrainedOn: isoDate(input.bushfireTrainedOn,'bushfire training date'),
    bushfireExpiresOn: isoDate(input.bushfireExpiresOn,'bushfire expiry/reassessment date'),
    evidenceReference: str(input.evidenceReference,'evidence reference',300),
    active: input.active == null ? true : option(input.active,[true,false],'active status'),
    notes: str(input.notes,'notes',700),
  };
}
function validateExtinguisher(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('Invalid extinguisher record');
  const capacity = Number(input.capacity);
  if (!Number.isFinite(capacity) || capacity <= 0 || capacity > 9999) bad('Invalid extinguisher capacity');
  const x = input.sceneX === '' || input.sceneX == null ? null : Number(input.sceneX);
  const z = input.sceneZ === '' || input.sceneZ == null ? null : Number(input.sceneZ);
  if ((x === null) !== (z === null) || (x !== null && (![x,z].every(Number.isFinite) || Math.abs(x)>1000 || Math.abs(z)>1000))) {
    bad('Supply both valid SiteNav X and Z coordinates, or neither');
  }
  return {
    id: uuid(input.id,'asset ID'), assetCode: str(input.assetCode,'asset code',65,true),
    type: str(input.type,'extinguisher type',60,true), capacity,
    unit: option(input.unit,['kg','L'],'capacity unit'),
    buildingRef: building(input.buildingRef),
    locationDetail: str(input.locationDetail,'exact location',250,true),
    sceneX:x, sceneZ:z,
    inspectedOn: isoDate(input.inspectedOn,'inspection date'),
    inspectionDueOn: isoDate(input.inspectionDueOn,'inspection due date'),
    condition: option(input.condition,CONDITIONS,'condition'),
    notes: str(input.notes,'notes',700),
  };
}
function validateTransition(current, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('Invalid status update');
  const next = option(input.status,STATUSES,'status');
  if (!(STATUS_NEXT[current] || []).includes(next)) throw new FireOpsError(409,'INVALID_STATUS_TRANSITION');
  const notNumber = next === 'notification_recorded' ? str(input.notNumber,'DFES NOT number',80,true) : null;
  if (notNumber && !/^[\w/ .-]+$/.test(notNumber)) bad('Invalid notification reference');
  return { status:next, notNumber };
}
function competencyStatus(trainedOn, expiresOn, today) {
  if (!trainedOn) return 'not_recorded';
  if (!expiresOn) return 'no_expiry_recorded';
  const asDate = value => value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`
    : String(value).slice(0,10);
  const dateMs = Date.parse(`${asDate(expiresOn)}T00:00:00Z`);
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(dateMs) || !Number.isFinite(todayMs)) return 'unknown';
  const days = Math.round((dateMs-todayMs)/86400000);
  return days < 0 ? 'expired' : days <= 30 ? 'due_soon' : 'current';
}
module.exports = { DEPARTMENTS,TRADES,STATUSES,STATUS_NEXT,FireOpsError,
  validateHotWork,validateStaff,validateExtinguisher,validateTransition,competencyStatus };

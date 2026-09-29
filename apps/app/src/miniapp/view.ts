// Что отдаёт API мини-приложения — ровно те типы, что рисуют экраны (apps/miniapp/src/model.ts).
// Импорт только типов: в сборку сервера клиентский код не попадает.

export type {
  AcceptanceResult,
  ChatStep,
  Command,
  Company,
  DiscrepancyReason,
  Driver,
  Employee,
  FileLink,
  Handoff,
  LineCheck,
  Me,
  Notice,
  OrgBrief,
  PoaAlert,
  RoleSummary,
  ShipEvent,
  Shipment,
  Signature,
  TitleView,
  Vehicle,
  VehicleInput,
} from '../../../miniapp/src/model.ts'

export type VehicleServiceSnapshot = {
  status: string
  isSpare: boolean
}

export type VehicleLaunchPoint = {
  stationId: string
  direction: number
  dwellMinutes: number
}

export function isVehicleInService(vehicle: VehicleServiceSnapshot): boolean {
  return vehicle.status === 'OPERATING' && !vehicle.isSpare
}

export function vehicleServiceUpdate(
  inService: boolean,
  launchPoint?: VehicleLaunchPoint,
) {
  if (!inService) {
    return {
      status: 'SPARE' as const,
      isSpare: true,
      currentStationId: null,
      segmentProgressMinutes: 0,
    }
  }

  if (!launchPoint) throw new Error('운행 시작 위치가 필요합니다.')
  return {
    status: 'OPERATING' as const,
    isSpare: false,
    currentStationId: launchPoint.stationId,
    direction: launchPoint.direction,
    segmentProgressMinutes: -launchPoint.dwellMinutes,
  }
}

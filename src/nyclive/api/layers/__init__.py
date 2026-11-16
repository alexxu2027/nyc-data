"""One builder per catalog layer id. Each takes a `Ctx` and returns a `LayerResult`."""

from __future__ import annotations

from collections.abc import Callable

from nyclive.api.layers import city, streets, trains, transit, water
from nyclive.api.layers.common import Ctx, LayerResult

BUILDERS: dict[str, Callable[[Ctx], LayerResult]] = {
    "boroughs": city.boroughs,
    "nws_alerts": water.nws_alerts,
    "road_speeds": streets.road_speeds,
    "complaints_311": city.complaints_311,
    "subway_stations": transit.subway_stations,
    "flood_sensors": water.flood_sensors,
    "citibike": transit.citibike,
    "cameras": streets.cameras,
    "collisions": streets.collisions,
    "elevator_outages": transit.elevator_outages,
    "subway_alerts": transit.subway_alerts,
    "subway_trains": trains.subway_trains,
    "flood_events": water.flood_events,
    "weather": water.weather,
    "tide_gauge": water.tide_gauge,
}

# Default and maximum `limit` per layer (None = everything).
LIMITS: dict[str, int] = {"complaints_311": city.LIMIT_311}
MAX_LIMIT = 20_000

__all__ = ["BUILDERS", "LIMITS", "MAX_LIMIT", "Ctx", "LayerResult"]

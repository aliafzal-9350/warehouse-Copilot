from pydantic import BaseModel
from typing import Optional, List
from datetime import date

class ReceivingLinePayload(BaseModel):
    item_code: str
    location: str
    quantity: int
    status: str
    batch_no: Optional[str] = None
    manufacturing_date: Optional[date] = None
    expiry_date: Optional[date] = None
    shelf_expiry_date: Optional[date] = None

class ReceivingPayload(BaseModel):
    customer: str
    warehouse: str
    receiving_date: date
    reference_no: str
    items: List[ReceivingLinePayload]

class ReceivingLineUpdatePayload(BaseModel):
    batch_no: Optional[str] = None
    status: Optional[str] = None

class ReceivingHeaderUpdatePayload(BaseModel):
    customer: Optional[str] = None
    warehouse: Optional[str] = None
    receiving_date: Optional[date] = None
    reference_no: Optional[str] = None
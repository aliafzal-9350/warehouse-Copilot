from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import or_, func
from app.core.database import SessionLocal
from app.models.item import Item
from app.models.warehouse import Warehouse
from app.models.location import Location
from app.models.receiving import ReceivingHeader, ReceivingLine

router = APIRouter()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

@router.get("/inventory")
def get_inventory(
    q: str | None = Query(default=None),
    customer: str | None = Query(default=None),
    reference_no: str | None = Query(default=None),
    date_from: str | None = Query(default=None),
    date_to: str | None = Query(default=None),
    item_code: str | None = Query(default=None),
    warehouse: str | None = Query(default=None),
    location: str | None = Query(default=None),
    db: Session = Depends(get_db)
):
    query = (
        db.query(
            ReceivingHeader.id.label("header_id"),
            ReceivingLine.id.label("line_id"),
            ReceivingHeader.customer.label("customer"),
            ReceivingHeader.receiving_date.label("receiving_date"),
            ReceivingHeader.reference_no.label("reference_no"),
            Warehouse.code.label("warehouse"),
            Item.code.label("item_code"),
            Location.code.label("location"),
            ReceivingLine.batch_no.label("batch_no"),
            ReceivingLine.manufacturing_date.label("manufacturing_date"),
            ReceivingLine.expiry_date.label("expiry_date"),
            ReceivingLine.shelf_expiry_date.label("shelf_expiry_date"),
            ReceivingLine.quantity.label("quantity"),
            ReceivingLine.status.label("status")
        )
        .join(ReceivingLine, ReceivingLine.receiving_id == ReceivingHeader.id)
        .join(Item, ReceivingLine.item_id == Item.id)
        .join(Warehouse, ReceivingHeader.warehouse_id == Warehouse.id)
        .join(Location, ReceivingLine.location_id == Location.id)
        .order_by(ReceivingHeader.receiving_date.desc(), ReceivingHeader.id.desc())
    )

    if q:
        like = f"%{q}%"
        query = query.filter(
            or_(
                ReceivingHeader.customer.ilike(like),
                ReceivingHeader.reference_no.ilike(like),
                Warehouse.code.ilike(like),
                Item.code.ilike(like),
                Location.code.ilike(like),
                ReceivingLine.batch_no.ilike(like),
                ReceivingLine.status.ilike(like)
            )
        )

    if customer:
        query = query.filter(ReceivingHeader.customer.ilike(f"%{customer}%"))
    if reference_no:
        query = query.filter(ReceivingHeader.reference_no.ilike(f"%{reference_no}%"))
    if date_from:
        query = query.filter(ReceivingHeader.receiving_date >= date_from)
    if date_to:
        query = query.filter(ReceivingHeader.receiving_date <= date_to)

    if item_code:
        query = query.filter(Item.code == item_code)
    if warehouse:
        query = query.filter(Warehouse.code == warehouse)
    if location:
        query = query.filter(Location.code == location)

    rows = [
        {
            "header_id": r.header_id,
            "line_id": r.line_id,
            "customer": r.customer,
            "receiving_date": str(r.receiving_date) if r.receiving_date else None,
            "reference_no": r.reference_no,
            "warehouse": r.warehouse,
            "item_code": r.item_code,
            "location": r.location,
            "batch_no": r.batch_no,
            "manufacturing_date": str(r.manufacturing_date) if r.manufacturing_date else None,
            "expiry_date": str(r.expiry_date) if r.expiry_date else None,
            "shelf_expiry_date": str(r.shelf_expiry_date) if r.shelf_expiry_date else None,
            "quantity": int(r.quantity or 0),
            "status": r.status
        }
        for r in query.all()
    ]

    return {"rows": rows}
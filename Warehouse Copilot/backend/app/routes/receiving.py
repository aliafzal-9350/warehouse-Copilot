from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.core.database import SessionLocal
from app.schemas.receiving import ReceivingPayload, ReceivingLineUpdatePayload, ReceivingHeaderUpdatePayload
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

@router.post("/confirm")
def confirm_receiving(payload: ReceivingPayload, db: Session = Depends(get_db)):
    warehouse = db.query(Warehouse).filter(Warehouse.code == payload.warehouse).first()
    if not warehouse:
        raise HTTPException(status_code=404, detail="Warehouse not found")

    header = ReceivingHeader(
        customer=payload.customer,
        receiving_date=payload.receiving_date,
        warehouse_id=warehouse.id,
        reference_no=payload.reference_no
    )
    db.add(header)
    db.flush()

    for line in payload.items:
        item_code = line.item_code.strip()
        item = db.query(Item).filter(Item.code == item_code).first()
        if not item:
            item = Item(code=item_code, name=item_code)
            db.add(item)
            db.flush()

        location = db.query(Location).filter(
            Location.code == line.location,
            Location.warehouse_id == warehouse.id
        ).first()
        if not location:
            raise HTTPException(status_code=404, detail=f"Location not found: {line.location}")

        db.add(ReceivingLine(
            receiving_id=header.id,
            item_id=item.id,
            location_id=location.id,
            quantity=line.quantity,
            batch_no=line.batch_no,
            manufacturing_date=line.manufacturing_date,
            expiry_date=line.expiry_date,
            shelf_expiry_date=line.shelf_expiry_date,
            status=line.status
        ))

    db.commit()
    db.refresh(header)

    return {"status": "success", "grn_id": header.id}

@router.patch("/lines/{line_id}")
def update_line(line_id: int, payload: ReceivingLineUpdatePayload, db: Session = Depends(get_db)):
    line = db.query(ReceivingLine).filter(ReceivingLine.id == line_id).first()
    if not line:
        raise HTTPException(status_code=404, detail="Line not found")

    if payload.item_code is not None:
        item = db.query(Item).filter(Item.code == payload.item_code).first()
        if not item:
            item = Item(code=payload.item_code, name=payload.item_code)
            db.add(item)
            db.flush()
        line.item_id = item.id

    if payload.location is not None:
        header = db.query(ReceivingHeader).filter(ReceivingHeader.id == line.receiving_id).first()
        location = db.query(Location).filter(
            Location.code == payload.location,
            Location.warehouse_id == header.warehouse_id
        ).first()
        if not location:
            raise HTTPException(status_code=404, detail=f"Location not found: {payload.location}")
        line.location_id = location.id

    if payload.batch_no is not None:
        line.batch_no = payload.batch_no
    if payload.manufacturing_date is not None:
        line.manufacturing_date = payload.manufacturing_date
    if payload.expiry_date is not None:
        line.expiry_date = payload.expiry_date
    if payload.shelf_expiry_date is not None:
        line.shelf_expiry_date = payload.shelf_expiry_date
    if payload.quantity is not None:
        line.quantity = payload.quantity
    if payload.status is not None:
        line.status = payload.status

    db.commit()
    db.refresh(line)
    return {"status": "success"}

@router.patch("/headers/{header_id}")
def update_header(header_id: int, payload: ReceivingHeaderUpdatePayload, db: Session = Depends(get_db)):
    header = db.query(ReceivingHeader).filter(ReceivingHeader.id == header_id).first()
    if not header:
        raise HTTPException(status_code=404, detail="Header not found")

    if payload.customer is not None:
        header.customer = payload.customer
    if payload.receiving_date is not None:
        header.receiving_date = payload.receiving_date
    if payload.reference_no is not None:
        header.reference_no = payload.reference_no
    if payload.warehouse is not None:
        warehouse = db.query(Warehouse).filter(Warehouse.code == payload.warehouse).first()
        if not warehouse:
            raise HTTPException(status_code=404, detail="Warehouse not found")
        header.warehouse_id = warehouse.id

    db.commit()
    db.refresh(header)
    return {"status": "success"}

@router.delete("/lines/{line_id}")
def delete_line(line_id: int, db: Session = Depends(get_db)):
    line = db.query(ReceivingLine).filter(ReceivingLine.id == line_id).first()
    if not line:
        raise HTTPException(status_code=404, detail="Line not found")

    db.delete(line)
    db.commit()
    return {"status": "deleted"}
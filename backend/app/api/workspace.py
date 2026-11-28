"""Bounded workspace reads. Aggregates run in PostgreSQL, not in browser arrays."""
from decimal import Decimal
from datetime import date,datetime,time,timedelta,timezone
from zoneinfo import ZoneInfo
from typing import Annotated,Literal
from uuid import UUID
from fastapi import APIRouter,Depends,Query,HTTPException
from pydantic import BaseModel,ConfigDict,Field
from sqlalchemy import select,func,or_,and_
from sqlalchemy.orm import Session,joinedload
from app.api.dependencies import get_tenant_scope
from app.db.session import get_db
from app.db.tenant import TenantScope
from app.models import Business,Customer,Staff,Service,Appointment,Payment
from app.schemas.resources import CustomerResponse,StaffResponse,ServiceResponse
from app.schemas.appointments import AppointmentResponse

from app.schemas.workspace import WorkspaceResponse

router=APIRouter(tags=['Workspace'])
MODELS={'customers':Customer,'staff':Staff,'services':Service}
SCHEMAS={Customer:CustomerResponse,Staff:StaffResponse,Service:ServiceResponse}
class WorkspaceQuery(BaseModel):
    model_config=ConfigDict(extra='forbid')
    view:Literal['dashboard','customers','staff','services','appointments','analytics','audit']='dashboard'
    page:int=Field(0,ge=0,le=5000)
    q:str=Field('',max_length=200)
    status:str=Field('',max_length=30)
    category:str=Field('',max_length=100)
    day:date|None=None
    staff_id:UUID|None=None
    customer_id:UUID|None=None
    history_page:int=Field(0,ge=0,le=5000)

def bounds(business):
    now=datetime.now(timezone.utc);day=now.astimezone(ZoneInfo(business.timezone)).date()
    start=datetime.combine(day,time.min,tzinfo=ZoneInfo(business.timezone)).astimezone(timezone.utc)
    end=datetime.combine(day+timedelta(days=1),time.min,tzinfo=ZoneInfo(business.timezone)).astimezone(timezone.utc)
    return now,day,start,end

def filtered(model,bid,q='',status='',category=''):
    stmt=select(model).where(model.business_id==bid)
    if q.strip():
        text=q.strip().lower();columns=[model.name]
        if model is Customer or model is Staff:columns.append(model.phone)
        if model is Staff:columns.append(model.specialty)
        if model is Service:columns.extend([model.category,model.description])
        terms=[func.lower(c).contains(text,autoescape=True) for c in columns]
        digits=''.join(c for c in text if c.isdigit())
        if model is Customer and digits:terms.append(model.phone.contains(digits.lstrip('0'),autoescape=True))
        stmt=stmt.where(or_(*terms))
    if model is not Customer and status:
        if status not in ('active','inactive'):raise HTTPException(422,'Invalid directory status')
        stmt=stmt.where(model.active==(status=='active'))
    if model is Service and category:
        stmt=stmt.where(or_(Service.category.is_(None),Service.category=='') if category=='uncategorized' else Service.category==category.removeprefix('category:'))
    return stmt

def page(session,stmt,offset=0,limit=20):
    total=session.scalar(select(func.count()).select_from(stmt.order_by(None).subquery()))
    model=stmt.column_descriptions[0]['entity']
    return dict(items=session.scalars(stmt.order_by(model.created_at.desc(),model.id).offset(offset).limit(limit)).all(),total=total,limit=limit,offset=offset)

def bookings(session,bid,stmt,offset=0,limit=20):
    total=session.scalar(select(func.count()).select_from(stmt.order_by(None).subquery()))
    rows=session.scalars(stmt.options(joinedload(Appointment.customer),joinedload(Appointment.staff),joinedload(Appointment.service)).order_by(Appointment.starts_at,Appointment.id).offset(offset).limit(limit)).all()
    paid=dict(session.execute(select(Payment.appointment_id,func.sum(Payment.amount)).where(Payment.business_id==bid,Payment.appointment_id.in_([a.id for a in rows])).group_by(Payment.appointment_id)).all()) if rows else {}
    result=[]
    from app.services.payments import payment_summary
    from app.schemas.payments import PaymentSummaryResponse
    for a in rows:
        value=AppointmentResponse.model_validate(a).model_dump(mode='json')
        value.update(customer_name=a.customer.name,staff_name=a.staff.name,service_name=a.service.name,
                payment_summary=PaymentSummaryResponse.model_validate(payment_summary(a.booked_price,paid.get(a.id,Decimal("0.00"))),from_attributes=True).model_dump(mode='json'))
        result.append(value)
    return dict(items=result,total=total,offset=offset,limit=limit)

def summary(session,business,page_number):
    bid=business.id;now,day,start,end=bounds(business)
    daily=select(Appointment).where(Appointment.business_id==bid,Appointment.starts_at>=start,Appointment.starts_at<end)
    counts=dict(session.execute(select(Appointment.status,func.count()).where(Appointment.business_id==bid,Appointment.starts_at>=start,Appointment.starts_at<end).group_by(Appointment.status)).all())
    statuses={key:counts.get(value,0) for key,value in [('Confirmed','confirmed'),('In progress','in_progress'),('Completed','completed'),('Cancelled','cancelled')]}
    future=select(Appointment).where(Appointment.business_id==bid,Appointment.status=='confirmed',Appointment.starts_at>=now)
    upcoming=bookings(session,bid,future,limit=5)
    work=select(Appointment.staff_id,func.count().label('count'),func.sum(Appointment.booked_duration_minutes).label('minutes')).where(Appointment.business_id==bid,Appointment.starts_at>=start,Appointment.starts_at<end,Appointment.status!='cancelled').group_by(Appointment.staff_id).subquery()
    workload=session.execute(select(Staff.id,Staff.name,Staff.active,func.coalesce(work.c.count,0),func.coalesce(work.c.minutes,0)).outerjoin(work,work.c.staff_id==Staff.id).where(Staff.business_id==bid).order_by(func.coalesce(work.c.count,0).desc(),Staff.name,Staff.id).offset(page_number*20).limit(20)).all()
    return dict(today=str(day),statuses=statuses,total=sum(statuses.values()),active=sum(statuses.values())-statuses['Cancelled'],
        remainingToday=session.scalar(select(func.count()).select_from(future.where(Appointment.starts_at<end).subquery())),
        upcoming=upcoming['items'],upcomingTotal=upcoming['total'],workload=[dict(id=str(id),name=name,active=active,appointments=n,minutes=m) for id,name,active,n,m in workload],
        staffTotal=session.scalar(select(func.count()).select_from(Staff).where(Staff.business_id==bid)),
        activeStaff=session.scalar(select(func.count()).select_from(Staff).where(Staff.business_id==bid,Staff.active.is_(True))),
        customerTotal=session.scalar(select(func.count()).select_from(Customer).where(Customer.business_id==bid)),
        appointmentTotal=session.scalar(select(func.count()).select_from(Appointment).where(Appointment.business_id==bid)))

@router.get('/api/workspace',response_model=WorkspaceResponse)
def workspace(scope:Annotated[TenantScope,Depends(get_tenant_scope)],session:Annotated[Session,Depends(get_db)],query:Annotated[WorkspaceQuery,Query()]):
    from app.db.locking import lock_business
    business=lock_business(session,scope,shared=True);bid=scope.business_id
    result=dict(business_id=str(bid),appointmentTotal=session.scalar(select(func.count()).select_from(Appointment).where(Appointment.business_id==bid)),customers=[],staff=[],services=[],appointments=[],total=0,history=None,dashboard=None)
    view=query.view
    if view in MODELS:
        model=MODELS[view];data=page(session,filtered(model,bid,query.q,query.status,query.category),query.page*20)
        result[view]=[SCHEMAS[model].model_validate(row).model_dump(mode='json') for row in data['items']];result['total']=data['total']
        if model is Customer and data['items']:
            stats=session.execute(select(Appointment.customer_id,func.count(),func.max(Appointment.starts_at)).where(Appointment.business_id==bid,Appointment.customer_id.in_([row.id for row in data['items']]),Appointment.status=='completed').group_by(Appointment.customer_id)).all()
            stats={id:(n,last) for id,n,last in stats}
            for row in result[view]:
                n,last=stats.get(UUID(row['id']),(0,None));row.update(completedVisits=n,lastCompleted=last.astimezone(ZoneInfo(business.timezone)).date().isoformat() if last else None)
        if model is Staff:
            _,_,start,end=bounds(business)
            counts=dict(session.execute(select(Appointment.staff_id,func.count()).where(Appointment.business_id==bid,Appointment.staff_id.in_([s.id for s in data['items']]),Appointment.starts_at>=start,Appointment.starts_at<end,Appointment.status!='cancelled').group_by(Appointment.staff_id)).all())
            for row in result[view]:row['todayCount']=counts.get(UUID(row['id']),0)
        if model in (Staff,Service):
            reference=Appointment.staff_id if model is Staff else Appointment.service_id
            counts=dict(session.execute(select(reference,func.count()).where(Appointment.business_id==bid,reference.in_([row.id for row in data['items']]),Appointment.status.in_(['confirmed','in_progress']),Appointment.ends_at>datetime.now(timezone.utc)).group_by(reference)).all())
            for row in result[view]:row['upcomingCount']=counts.get(UUID(row['id']),0)
    if view=='appointments' or query.customer_id:
        stmt=select(Appointment).where(Appointment.business_id==bid)
        if query.customer_id:
            scope.get(session,Customer,query.customer_id);stmt=stmt.where(Appointment.customer_id==query.customer_id)
        else:
            if query.q:stmt=stmt.join(Customer,and_(Customer.id==Appointment.customer_id,Customer.business_id==bid)).where(func.lower(Customer.name).contains(query.q.strip().lower(),autoescape=True))
            if query.status:
                statuses={'Confirmed':'confirmed','In progress':'in_progress','Completed':'completed','Cancelled':'cancelled'}
                if query.status not in statuses:raise HTTPException(422,'Invalid appointment status')
                stmt=stmt.where(Appointment.status==statuses[query.status])
            if query.staff_id:
                scope.get(session,Staff,query.staff_id);stmt=stmt.where(Appointment.staff_id==query.staff_id)
            if query.day:
                try:
                    zone=ZoneInfo(business.timezone);start=datetime.combine(query.day,time.min,tzinfo=zone);end=start+timedelta(days=1)
                except (ValueError,OverflowError):raise HTTPException(422,'Invalid date range') from None
                stmt=stmt.where(Appointment.starts_at>=start,Appointment.starts_at<end)
        data=bookings(session,bid,stmt,(query.history_page if query.customer_id else query.page)*20)
        if query.customer_id:result['history']=data
        else:result['appointments']=data['items'];result['total']=data['total']
    if view=='dashboard':
        result['dashboard']=summary(session,business,query.page);result['total']=result['dashboard']['staffTotal']
    return result

@router.get('/api/booking-options/{resource}')
def options(resource:Literal['customers','staff','services'],scope:Annotated[TenantScope,Depends(get_tenant_scope)],session:Annotated[Session,Depends(get_db)],q:Annotated[str,Query(max_length=200)]='',offset:Annotated[int,Query(ge=0,le=100000)]=0):
    model=MODELS[resource];data=page(session,filtered(model,scope.business_id,q),offset)
    data['items']=[SCHEMAS[model].model_validate(row).model_dump(mode='json') for row in data['items']]
    return data
